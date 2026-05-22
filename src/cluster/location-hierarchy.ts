/**
 * 地域階層分類:
 *   location 軸の axis_value を「親(top: 都道府県/主要政令市) / 子(sub: 区/駅/小都市)」に分類。
 *   結果は location_hierarchy 表に保存。CSV/UI は parent_value で grouping 表示する。
 *
 * 例:
 *   東京 → level=top, parent=null
 *   大阪 → level=top
 *   三軒茶屋 → level=sub, parent=東京
 *   梅田 → level=sub, parent=大阪
 *   天神 → level=sub, parent=福岡
 */
import { kwDb } from '../lib/db.js';
import { claudeText } from '../lib/claude.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

const BATCH_SIZE = 50;

const SYSTEM_LOCATION = `あなたは日本地理の専門家です。AGA(医療)関連検索KWに出てくる地名を「親/子」階層に分類してください。

【親レベル (top)】
- 都道府県名 (東京/大阪/愛知/福岡/北海道/宮城/広島/...)
- 政令指定都市・主要都市 (横浜/名古屋/福岡/札幌/仙台/京都/神戸/広島/さいたま/千葉/堺/北九州...)

【子レベル (sub)】
- 区 (新宿/渋谷/銀座/上野/三軒茶屋/恵比寿/池袋/秋葉原/八重洲/新橋/銀座...)
- 駅・町域・小都市 (梅田/心斎橋/天神/大宮/船橋/八王子/町田/立川/表参道...)
- 中規模都市 (姫路/岡山/橿原/松山/福山/つくば/松阪市/橿原/船橋...)

【判定ルール】
- 都道府県名は top (parent=null)
- 主要政令市・県庁所在地は top (parent=null)
- 区・駅・町域は sub + 適切な親都市 (= top レベル名)
- 中規模都市は sub + 所属都道府県
- 北海道の小都市 (滝川/恵庭/北見/etc) は sub + parent="北海道"
- 不明・判定困難なら level="unknown" parent=null
- "東京都" は "東京" に正規化 (キー値はそのまま使用、parent値の表記を統一)

【出力形式】 JSON配列のみ:
[
  {"location": "三軒茶屋", "level": "sub", "parent": "東京", "confidence": 0.95},
  {"location": "東京", "level": "top", "parent": null, "confidence": 1.0},
  {"location": "梅田", "level": "sub", "parent": "大阪", "confidence": 0.95},
  {"location": "横浜", "level": "top", "parent": null, "confidence": 0.95}
]
`;

interface ClassifyRow {
  location: string;
  level: 'top' | 'sub' | 'unknown';
  parent: string | null;
  confidence: number;
}

function parseJson(text: string): unknown[] {
  const m = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/) ?? [null, text];
  const body = (m[1] ?? text).trim();
  const s = body.indexOf('[');
  const e = body.lastIndexOf(']');
  if (s < 0 || e < 0 || e <= s) throw new Error(`location classify not JSON: ${text.slice(0, 200)}`);
  const arr = JSON.parse(body.slice(s, e + 1));
  if (!Array.isArray(arr)) throw new Error('not array');
  return arr;
}

async function classifyBatch(values: string[]): Promise<ClassifyRow[]> {
  if (values.length === 0) return [];
  const user = `分類対象 (${values.length}件):\n${values.map((v, i) => `${i + 1}. ${v}`).join('\n')}\n\n上記をJSON配列で返してください。`;
  const text = await claudeText({ system: SYSTEM_LOCATION, user, maxTokens: 4096 });
  const arr = parseJson(text) as ClassifyRow[];
  return arr.filter((r) => typeof r.location === 'string' && ['top', 'sub', 'unknown'].includes(r.level));
}

export interface LocationHierarchyResult {
  totalLocations: number;
  classified: number;
  byLevel: Record<string, number>;
  llmCalls: number;
}

export async function runLocationHierarchy(runId: string): Promise<LocationHierarchyResult> {
  const db = kwDb();
  const values = (
    db
      .prepare(
        `SELECT DISTINCT ca.axis_value AS v FROM candidate_axes ca
         JOIN l1_candidates lc ON lc.id=ca.candidate_id
         WHERE lc.run_id=? AND ca.axis='location' AND ca.axis_value != ''
         ORDER BY ca.axis_value`,
      )
      .all(runId) as Array<{ v: string }>
  ).map((r) => r.v);

  if (values.length === 0) {
    return { totalLocations: 0, classified: 0, byLevel: {}, llmCalls: 0 };
  }

  const ins = db.prepare(
    `INSERT INTO location_hierarchy (run_id, child_value, parent_value, level, confidence)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id, child_value) DO UPDATE SET
       parent_value=excluded.parent_value, level=excluded.level, confidence=excluded.confidence`,
  );

  const byLevel: Record<string, number> = { top: 0, sub: 0, unknown: 0 };
  let classified = 0;
  let llmCalls = 0;

  // 既存clear
  db.prepare(`DELETE FROM location_hierarchy WHERE run_id=?`).run(runId);

  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    const slice = values.slice(i, i + BATCH_SIZE);
    try {
      const rows = await classifyBatch(slice);
      llmCalls++;
      const byLoc = new Map(rows.map((r) => [r.location, r] as const));
      db.transaction(() => {
        for (const v of slice) {
          const r = byLoc.get(v);
          if (r) {
            ins.run(runId, v, r.parent ?? null, r.level, r.confidence ?? 0.7);
            byLevel[r.level] = (byLevel[r.level] ?? 0) + 1;
          } else {
            ins.run(runId, v, null, 'unknown', 0.3);
            byLevel['unknown'] = (byLevel['unknown'] ?? 0) + 1;
          }
          classified++;
        }
      })();
      logger.info({ runId, batchIdx: Math.floor(i / BATCH_SIZE), size: slice.length }, '[loc-h] batch');
    } catch (e) {
      logger.error({ runId, err: (e as Error).message }, '[loc-h] batch failed');
    }
  }

  audit({
    actor: 'system',
    eventType: 'location_hierarchy.complete',
    entityType: 'run',
    entityId: runId,
    after: { totalLocations: values.length, classified, byLevel, llmCalls },
  });

  logger.info({ runId, totalLocations: values.length, classified, byLevel, llmCalls }, '[loc-h] done');

  return { totalLocations: values.length, classified, byLevel, llmCalls };
}
