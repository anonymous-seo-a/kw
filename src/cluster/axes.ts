/**
 * [AX] Modifier 軸事前分類:
 *   各候補KWに 0..n の modifier 軸を付与し、L3クラスタリング前に「軸ごとのバケット」を作る。
 *
 * 仕様 §4 rev 2026-05-22-2:
 *   "AGA おすすめ" のような silo は location/cost/drug/audience/format/condition/trust/informational
 *   の直交 modifier 軸を持つ。pure intent の KW は 'core' バケット。
 *   2+ 軸を持つ KW は bridge であり、NEC で passage_absorbed として親pageに吸収される。
 */
import { claudeText } from '../lib/claude.js';
import { kwDb } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';

export type Axis =
  | 'core'
  | 'location'
  | 'cost'
  | 'drug'
  | 'audience'
  | 'format'
  | 'condition'
  | 'trust'
  | 'informational';

const ALL_AXES: Axis[] = [
  'core',
  'location',
  'cost',
  'drug',
  'audience',
  'format',
  'condition',
  'trust',
  'informational',
];

interface ClassifyRow {
  kw: string;
  axes: Array<{ axis: Axis; value: string | null; confidence: number }>;
}

const BATCH_SIZE = 40;

function buildSystem(seedKw: string, vertical: string | null): string {
  return `あなたは検索KWの modifier 軸分類器です。silo seed "${seedKw}"${vertical ? ` (領域: ${vertical})` : ''} に対し、与えられた候補KWを以下9軸に分類してください。

軸定義:
- core: silo intent (例: "aga おすすめ", "aga 治療") の純粋表現。他modifier無し
- location: 地域名 (東京/大阪/福岡/上野/梅田/都内/関西/地方名...)
- cost: 価格/保険意図 (保険適用/安い/料金/相場/費用/高い/月額)
- drug: 具体的薬剤名 (フィナステリド/ミノキシジル/プロペシア/デュタステリド/ザガーロ等)
- audience: 性別/年齢/属性 (女性/男性/メンズ/20代/30代/若年/学生)
- format: 形態 (オンライン/皮膚科/専門クリニック/総合/個人医院)
- condition: 症状/状態の細分化 (M字/初期/進行/手遅れ/効果ない/つむじ/前頭部)
- trust: 信頼/評判 (口コミ/評判/知恵袋/比較/ランキング/失敗/後悔)
- informational: 情報意図 (とは/原因/仕組み/予防/遺伝/治る/見分け方/メカニズム)

ルール:
- 軸は **複数同時付与可** (例: "aga 東京 保険適用" → [location: "東京"], [cost: "保険適用"])
- "core" は **他軸が無いときのみ** 付与 (純intent KW)
- axis_value は KWからの抜粋語 (location なら地名そのもの)。core は null
- confidence は 0.0-1.0
- 出力は **JSON配列のみ** (前後に文を書かない)

出力形式:
[
  {"kw": "aga 東京 おすすめ", "axes": [{"axis":"location","value":"東京","confidence":0.95}]},
  {"kw": "aga 治療", "axes": [{"axis":"core","value":null,"confidence":0.9}]},
  {"kw": "aga治療 東京 保険適用", "axes": [{"axis":"location","value":"東京","confidence":0.95},{"axis":"cost","value":"保険適用","confidence":0.95}]}
]`;
}

function parseJsonArray(text: string): unknown[] {
  const m = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/) ?? [null, text];
  const body = (m[1] ?? text).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`axes output not JSON array: ${text.slice(0, 200)}`);
  }
  const arr = JSON.parse(body.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('axes: parsed not array');
  return arr;
}

async function classifyBatch(
  seedKw: string,
  vertical: string | null,
  candidates: Array<{ id: number; keyword: string }>,
): Promise<Array<{ id: number; kw: string; axes: ClassifyRow['axes'] }>> {
  const system = buildSystem(seedKw, vertical);
  const user = `候補KW (${candidates.length}件):\n${candidates.map((c, i) => `${i + 1}. ${c.keyword}`).join('\n')}\n\n上記をJSON配列で分類してください。`;
  const text = await claudeText({ system, user, maxTokens: 8192 });
  const parsed = parseJsonArray(text) as ClassifyRow[];

  // kw照合 (順序依存はせず KWテキストで突き合わせ)
  const byKw = new Map<string, ClassifyRow['axes']>();
  for (const p of parsed) {
    if (typeof p.kw === 'string' && Array.isArray(p.axes)) {
      byKw.set(p.kw, p.axes.filter((a) => ALL_AXES.includes(a.axis as Axis)));
    }
  }

  const out: Array<{ id: number; kw: string; axes: ClassifyRow['axes'] }> = [];
  for (const c of candidates) {
    const axes = byKw.get(c.keyword);
    if (axes && axes.length > 0) {
      out.push({ id: c.id, kw: c.keyword, axes });
    } else {
      // fallback: 軸不明 → core
      out.push({
        id: c.id,
        kw: c.keyword,
        axes: [{ axis: 'core', value: null, confidence: 0.3 }],
      });
    }
  }
  return out;
}

export interface AxisRunResult {
  candidatesTotal: number;
  classified: number;
  byAxis: Record<string, number>;
  multiAxisBridges: number;
  pureCore: number;
  llmCalls: number;
}

export async function runAxisClassification(runId: string): Promise<AxisRunResult> {
  const db = kwDb();
  const runRow = db.prepare(`SELECT seed_kw, vertical FROM runs WHERE run_id=?`).get(runId) as
    | { seed_kw: string; vertical: string | null }
    | undefined;
  if (!runRow) throw new Error(`run not found: ${runId}`);

  const candidates = db
    .prepare(`SELECT id, keyword FROM l1_candidates WHERE run_id=? ORDER BY id`)
    .all(runId) as Array<{ id: number; keyword: string }>;
  if (candidates.length === 0) {
    return {
      candidatesTotal: 0,
      classified: 0,
      byAxis: {},
      multiAxisBridges: 0,
      pureCore: 0,
      llmCalls: 0,
    };
  }

  const ins = db.prepare(
    `INSERT OR REPLACE INTO candidate_axes (candidate_id, axis, axis_value, confidence, source)
     VALUES (?, ?, COALESCE(?, ''), ?, 'claude')`,
  );

  // 既存軸の掃除
  db.prepare(
    `DELETE FROM candidate_axes WHERE candidate_id IN
       (SELECT id FROM l1_candidates WHERE run_id=?)`,
  ).run(runId);

  let classified = 0;
  let llmCalls = 0;
  const byAxis: Record<string, number> = Object.fromEntries(ALL_AXES.map((a) => [a, 0]));
  let multi = 0;
  let core = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const slice = candidates.slice(i, i + BATCH_SIZE);
    try {
      const rows = await classifyBatch(runRow.seed_kw, runRow.vertical, slice);
      llmCalls++;
      db.transaction(() => {
        for (const r of rows) {
          for (const a of r.axes) {
            ins.run(r.id, a.axis, a.value ?? null, a.confidence ?? 0.5);
            byAxis[a.axis] = (byAxis[a.axis] ?? 0) + 1;
          }
          // 多軸 bridge / pure core 集計
          const distinctAxes = new Set(r.axes.map((a) => a.axis));
          if (distinctAxes.size >= 2 && !distinctAxes.has('core')) multi++;
          if (distinctAxes.size === 1 && distinctAxes.has('core')) core++;
          classified++;
        }
      })();
      logger.info(
        { runId, batchIdx: Math.floor(i / BATCH_SIZE), size: slice.length },
        '[AX] batch classified',
      );
    } catch (e) {
      logger.error(
        { runId, batchIdx: Math.floor(i / BATCH_SIZE), err: (e as Error).message },
        '[AX] batch failed',
      );
    }
  }

  audit({
    actor: 'system',
    eventType: 'ax.complete',
    entityType: 'run',
    entityId: runId,
    after: { candidatesTotal: candidates.length, classified, byAxis, multi, core, llmCalls },
  });

  logger.info(
    { runId, candidatesTotal: candidates.length, classified, byAxis, multi, core, llmCalls },
    '[AX] complete',
  );

  return {
    candidatesTotal: candidates.length,
    classified,
    byAxis,
    multiAxisBridges: multi,
    pureCore: core,
    llmCalls,
  };
}
