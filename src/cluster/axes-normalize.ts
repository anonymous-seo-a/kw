/**
 * [AX-NORM] 軸値正規化:
 *   同義/同SEO意図の axis_value を canonical に圧縮する。
 *   例:
 *     cost:  {安い, 費用, 料金, 相場, 月額} → "費用・安さ"  (※保険適用は別意図で残す)
 *     trust: {おすすめ, ランキング, 比較, 人気} → "比較・ランキング" (※口コミ/失敗は別)
 *
 *   location/drug/core は granular 保持 (東京と上野/フィナステリドとミノキシジルは別page)。
 *
 * 仕様§4 rev 2026-05-22-2 補足: 軸値の同義圧縮は SEO 意図ベース。
 */
import { kwDb } from '../lib/db.js';
import { claudeText } from '../lib/claude.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

// brand/location/drug/core は granular保持 (各値が個別エンティティ)
const NORMALIZE_AXES = ['cost', 'trust', 'format', 'informational', 'condition', 'audience'] as const;

const AXIS_CONTEXT: Record<(typeof NORMALIZE_AXES)[number], string> = {
  cost: '価格/コスト系の修飾語。"保険適用"は別意図(保険適用可否)として独立させる。それ以外(安い/費用/料金/相場/月額/格安/高い)は同じSEO意図として統合してよい。"無料"は別意図。',
  trust: '信頼/社会的証明系。"比較/ランキング/おすすめ/人気/比較サイト/比較ランキング/おすすめランキング/おすすめ15院" は全て同じ「ベスト院リスト」意図 → 統合。"口コミ/評判/レビュー" は別意図。"後悔/失敗/効果ない/危ない" はネガティブ体験談で別意図。"知恵袋" はQ&Aで別意図。',
  format: '形態系。"オンライン/オンライン診療" は統合。"皮膚科/総合病院" は別意図。"専門/専門クリニック/AGAクリニック" は統合。"市販/通販/薬局" は統合。',
  informational: '情報意図系。"とは/概要/意味" は統合。"原因/仕組み/メカニズム/理由" は統合。"予防/対策" は統合。"治る/治療できる/治療可能" は統合。"見分け方/判別/診断" は別意図。"進行/進行度" は別意図(condition軸候補)。',
  condition: '症状/状態系。"初期/初期症状/初期段階" は統合。"進行/進行度/ステージ/末期" は統合。"M字/M字ハゲ/M字型" は統合。"つむじ/頭頂部" は統合。"効果ない/効果なし/効かない" は統合。',
  audience: '対象属性系。"女性/女性型/レディース" は統合。"若年/20代/学生/若い" は統合。"メンズ/男性/男" は統合 (※core暗黙のためメンズはほぼcoreに吸収されるが残す場合は統合)。年代は10代/20代/30代/40代/50代/60代を個別に残す。',
};

interface CanonicalGroup {
  canonical: string;
  members: string[];
}

function parseJsonArray(text: string): unknown[] {
  const m = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/) ?? [null, text];
  const body = (m[1] ?? text).trim();
  const s = body.indexOf('[');
  const e = body.lastIndexOf(']');
  if (s < 0 || e < 0 || e <= s) throw new Error(`normalize output not array: ${text.slice(0, 200)}`);
  const arr = JSON.parse(body.slice(s, e + 1));
  if (!Array.isArray(arr)) throw new Error('normalize: parsed not array');
  return arr;
}

async function normalizeOneAxis(
  axis: (typeof NORMALIZE_AXES)[number],
  values: string[],
): Promise<CanonicalGroup[]> {
  if (values.length === 0) return [];
  const ctx = AXIS_CONTEXT[axis];
  const system = `あなたはSEO意図ベースの修飾語正規化器です。同じSEO検索意図を持つ修飾語を同一グループに統合します。

軸: ${axis}
軸の意味: ${ctx}

ルール:
- 各グループに canonical (代表語) を1つ与え、members に同義語を列挙
- canonical は最も自然な短い日本語 (中黒併用可。例: "比較・ランキング")
- どの値も必ずいずれか1グループに属する
- 単独で他と統合できない値は単一memberグループとして残す
- 出力は **JSON配列のみ** (前後説明なし)
`;
  const user = `軸 "${axis}" の axis_value 一覧 (${values.length}件):\n${values.map((v, i) => `${i + 1}. ${v}`).join('\n')}\n\nSEO意図ベースで canonical グループ化してください。\n\n出力形式:\n[{"canonical": "費用・安さ", "members": ["安い", "費用", "料金", "相場"]}, ...]`;

  const text = await claudeText({ system, user, maxTokens: 4096 });
  const arr = parseJsonArray(text) as CanonicalGroup[];

  // 検証: 全valuesがどこかに属するか
  const covered = new Set<string>();
  for (const g of arr) {
    for (const m of g.members ?? []) covered.add(m);
  }
  // 漏れは singleton として追加
  for (const v of values) {
    if (!covered.has(v)) arr.push({ canonical: v, members: [v] });
  }
  return arr;
}

export interface NormalizeResult {
  axesProcessed: string[];
  totalValuesBefore: number;
  totalCanonicalsAfter: number;
  groups: Array<{ axis: string; canonical: string; members: string[] }>;
  llmCalls: number;
}

export async function normalizeAxisValues(runId: string): Promise<NormalizeResult> {
  const db = kwDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT ca.axis, ca.axis_value
       FROM candidate_axes ca
       JOIN l1_candidates lc ON lc.id=ca.candidate_id
       WHERE lc.run_id=? AND ca.axis_value != ''`,
    )
    .all(runId) as Array<{ axis: string; axis_value: string }>;

  const byAxis = new Map<string, string[]>();
  for (const r of rows) {
    if (!NORMALIZE_AXES.includes(r.axis as any)) continue;
    if (!byAxis.has(r.axis)) byAxis.set(r.axis, []);
    byAxis.get(r.axis)!.push(r.axis_value);
  }

  const groups: NormalizeResult['groups'] = [];
  let llmCalls = 0;
  let totalBefore = 0;
  let totalAfter = 0;

  for (const [axis, values] of byAxis) {
    if (values.length < 2) {
      groups.push({ axis, canonical: values[0]!, members: [...values] });
      totalBefore += values.length;
      totalAfter += 1;
      continue;
    }
    try {
      const g = await normalizeOneAxis(axis as (typeof NORMALIZE_AXES)[number], values);
      llmCalls++;
      for (const gi of g) groups.push({ axis, canonical: gi.canonical, members: gi.members ?? [] });
      totalBefore += values.length;
      totalAfter += g.length;
    } catch (e) {
      logger.error({ runId, axis, err: (e as Error).message }, '[AX-NORM] axis normalize failed');
      // フォールバック: そのまま単独グループに
      for (const v of values) groups.push({ axis, canonical: v, members: [v] });
      totalBefore += values.length;
      totalAfter += values.length;
    }
  }

  // candidate_axes に canonical を反映
  db.transaction(() => {
    const upd = db.prepare(
      `UPDATE candidate_axes SET axis_value=?
       WHERE axis=? AND axis_value=? AND candidate_id IN
         (SELECT id FROM l1_candidates WHERE run_id=?)`,
    );
    // 同一PK衝突回避のため、まず canonical 行を別キーへ移動 → memberを書き換え → dedup
    // 簡易戦略: 1) member→tempキーへ書き換え 2) tempキー→canonical へ書き換え (insert or ignore dedup)
    // SQLiteのUPDATEはPK衝突でabortするため、削除→挿入で対応する。
    const sel = db.prepare(
      `SELECT candidate_id, MAX(confidence) AS conf
       FROM candidate_axes
       WHERE axis=? AND axis_value IN (${'?,'.repeat(0).slice(0, -1)})`,
    );
    const ins = db.prepare(
      `INSERT OR IGNORE INTO candidate_axes (candidate_id, axis, axis_value, confidence, source)
       VALUES (?, ?, ?, ?, 'claude-normalize')`,
    );
    const del = db.prepare(
      `DELETE FROM candidate_axes
       WHERE axis=? AND axis_value=? AND candidate_id IN (SELECT id FROM l1_candidates WHERE run_id=?)`,
    );

    for (const g of groups) {
      const members = g.members.filter((m) => m !== g.canonical);
      if (members.length === 0) continue;
      const ph = members.map(() => '?').join(',');
      const targets = db
        .prepare(
          `SELECT DISTINCT candidate_id, MAX(confidence) AS conf
           FROM candidate_axes
           WHERE axis=? AND axis_value IN (${ph}) AND candidate_id IN (SELECT id FROM l1_candidates WHERE run_id=?)
           GROUP BY candidate_id`,
        )
        .all(g.axis, ...members, runId) as Array<{ candidate_id: number; conf: number | null }>;
      for (const t of targets) {
        ins.run(t.candidate_id, g.axis, g.canonical, t.conf ?? 0.7);
      }
      for (const m of members) del.run(g.axis, m, runId);
    }
  })();

  audit({
    actor: 'system',
    eventType: 'ax.normalize',
    entityType: 'run',
    entityId: runId,
    after: { groups, totalBefore, totalAfter, llmCalls },
  });

  logger.info(
    { runId, axesProcessed: [...byAxis.keys()], totalBefore, totalAfter, llmCalls },
    '[AX-NORM] axis values normalized',
  );

  return {
    axesProcessed: [...byAxis.keys()],
    totalValuesBefore: totalBefore,
    totalCanonicalsAfter: totalAfter,
    groups,
    llmCalls,
  };
}
