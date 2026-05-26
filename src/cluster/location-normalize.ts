/**
 * 修正C-1: location axis_value の正規化 (spec-01)
 *
 *   表記ゆれ (新宿/東京 新宿/東京新宿) を Claude が 1つの canonical 値に統合。
 *   - 候補KW investigation: substring/space/case match で variant 候補を生成
 *   - Claude に渡して「同一商圏か」「どの canonical を採用するか」を確定
 *   - candidate_axes.axis_value を canonical に書換
 *   - location_normalization テーブルに記録
 *
 *   この前処理により L3 で同一商圏の表記ゆれが同一bucketに集約される。
 */
import { kwDb } from '../lib/db.js';
import { claudeText } from '../lib/claude.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

const SYSTEM_NORMALIZE = `あなたは日本地理の正規化器です。AGAクリニックSEO関連の地名リストに含まれる表記ゆれ・同一商圏異表記を統合してください。

【統合ルール】
- 表記ゆれ: "東京 新宿" / "東京新宿" / "新宿" → canonical="新宿" (区/駅単位)
- 都道府県表記: "東京都" → canonical="東京"
- 市表記: "岡山市" → "岡山", "福岡市" → "福岡"
- 区表記: "札幌市北区" → "札幌"
- 同一商圏内の駅/サブエリア: "西梅田" / "大阪梅田" / "梅田" → canonical="梅田" (= 商圏統合)
- 但し別商圏は別: "新宿" ≠ "渋谷", "梅田" ≠ "心斎橋"

【判定原則】
- 同一の検索意図 (= 同じSEO記事で扱う商圏) なら統合
- 親都市と子の関係 (東京⊃新宿) は別物として保持 (canonical='新宿' は '東京' とは別)
- false positive (京都 ≠ 東京都) は統合しない

【出力】 JSON配列のみ:
[
  {"original": "東京 新宿", "canonical": "新宿"},
  {"original": "東京新宿", "canonical": "新宿"},
  {"original": "東京都", "canonical": "東京"},
  {"original": "大阪梅田", "canonical": "梅田"},
  {"original": "札幌市北区", "canonical": "札幌"},
  {"original": "岡山市", "canonical": "岡山"}
]

original==canonical の場合 (= 統合先となる canonical 自身) は出力に含めなくてよい。
`;

const BATCH_SIZE = 60;

interface NormalizeRow {
  original: string;
  canonical: string;
}

function parseJson(text: string): unknown[] {
  const m = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/) ?? [null, text];
  const body = (m[1] ?? text).trim();
  const s = body.indexOf('[');
  const e = body.lastIndexOf(']');
  if (s < 0 || e < 0 || e <= s) throw new Error(`normalize output not JSON: ${text.slice(0, 200)}`);
  const arr = JSON.parse(body.slice(s, e + 1));
  if (!Array.isArray(arr)) throw new Error('not array');
  return arr;
}

export interface LocationNormalizeResult {
  totalValues: number;
  normalized: number;
  pairs: Array<{ original: string; canonical: string }>;
  llmCalls: number;
}

export async function runLocationNormalize(runId: string): Promise<LocationNormalizeResult> {
  const db = kwDb();
  // 全 distinct location axis_value 取得
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
    return { totalValues: 0, normalized: 0, pairs: [], llmCalls: 0 };
  }

  const allMappings: NormalizeRow[] = [];
  let llmCalls = 0;

  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    const slice = values.slice(i, i + BATCH_SIZE);
    try {
      const text = await claudeText({
        system: SYSTEM_NORMALIZE,
        user: `対象 (${slice.length}件):\n${slice.map((v, j) => `${j + 1}. ${v}`).join('\n')}\n\n統合候補のみをJSON配列で返してください (original→canonical)。`,
        maxTokens: 4096,
      });
      llmCalls++;
      const rows = parseJson(text) as NormalizeRow[];
      for (const r of rows) {
        if (typeof r.original === 'string' && typeof r.canonical === 'string' && r.original !== r.canonical) {
          allMappings.push(r);
        }
      }
      logger.info({ runId, batch: Math.floor(i / BATCH_SIZE) + 1, batchPairs: rows.length }, '[loc-norm] batch');
    } catch (e) {
      logger.error({ runId, err: (e as Error).message }, '[loc-norm] batch failed');
    }
  }

  // 反映: candidate_axes の axis_value を更新 + 記録
  db.transaction(() => {
    db.prepare(`DELETE FROM location_normalization WHERE run_id=?`).run(runId);
    const insMap = db.prepare(
      `INSERT OR REPLACE INTO location_normalization (run_id, original_value, canonical_value, kind)
       VALUES (?, ?, ?, 'variant')`,
    );
    for (const m of allMappings) insMap.run(runId, m.original, m.canonical);

    // UPDATE candidate_axes: original → canonical (PK衝突回避: 既存canonical行があるなら member-only書換、なければ普通にUPDATE)
    for (const m of allMappings) {
      // canonical 行が既存の同 candidate に存在するか確認するため: まず candidates with original axis を取得
      const candWithOrig = db
        .prepare(
          `SELECT candidate_id FROM candidate_axes ca
           WHERE ca.axis='location' AND ca.axis_value=? AND ca.candidate_id IN
             (SELECT id FROM l1_candidates WHERE run_id=?)`,
        )
        .all(m.original, runId) as Array<{ candidate_id: number }>;
      for (const c of candWithOrig) {
        // 既に canonical 行があるか?
        const hasCanonical = db
          .prepare(`SELECT 1 FROM candidate_axes WHERE candidate_id=? AND axis='location' AND axis_value=?`)
          .get(c.candidate_id, m.canonical);
        if (hasCanonical) {
          // 既存 → original を削除
          db.prepare(
            `DELETE FROM candidate_axes WHERE candidate_id=? AND axis='location' AND axis_value=?`,
          ).run(c.candidate_id, m.original);
        } else {
          // 更新
          db.prepare(
            `UPDATE candidate_axes SET axis_value=? WHERE candidate_id=? AND axis='location' AND axis_value=?`,
          ).run(m.canonical, c.candidate_id, m.original);
        }
      }
    }
  })();

  audit({
    actor: 'system',
    eventType: 'location_normalize.complete',
    entityType: 'run',
    entityId: runId,
    after: { totalValues: values.length, normalized: allMappings.length, llmCalls },
  });

  logger.info(
    { runId, totalValues: values.length, normalized: allMappings.length, llmCalls },
    '[loc-norm] done',
  );

  return { totalValues: values.length, normalized: allMappings.length, pairs: allMappings, llmCalls };
}
