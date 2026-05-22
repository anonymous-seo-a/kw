/**
 * 意図フィルタ: SEO記事化しないKWを除外する仕組み。
 *
 *  - forum_qa: 知恵袋 / 2ch / 5ch / 掲示板 / なんJ / まとめサイト 等
 *    (ユーザが「フォーラム/Q&Aサイトを探す」意図でありメディア記事の対象外)
 *  - brand: 競合ブランド名を含むKW (brand軸付与済の候補)
 *    (自社siloは競合brand+modifierをtargetしない。inventoryには残るがpageには出さない)
 *
 * 設定:
 *   config 'intent_filter_forum_qa_patterns' (string[]) で patterns を上書き可。
 *
 * 効果:
 *   - candidate_filters に記録 (kind='forum_qa' | 'brand')
 *   - L3 loadInRegion() がfilteredを除外 → 任意cluster member にならない
 *   - COV: page coverage に含まれない (kw:候補は inventory にあるが page_id=NULL)
 *   - UI: 「除外KW」セクションに別表示
 */
import { kwDb } from '../lib/db.js';
import { getConfigOr } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

const DEFAULT_FORUM_QA_PATTERNS: string[] = [
  '知恵袋',
  '2ch',
  '5ch',
  '2チャン',
  '5チャン',
  'なんJ',
  'なんj',
  '掲示板',
  'まとめサイト',
  'まとめ ',
  'ヤフー知恵',
  'ガールズちゃんねる',
  'ガルちゃん',
  'reddit',
  'Reddit',
  'Q&A',
];

export interface IntentFilterResult {
  patterns: string[];
  candidatesTotal: number;
  filteredForumQa: number;
  filteredBrand: number;
  filteredTotal: number;
  byPattern: Record<string, number>;
}

export async function runIntentFilters(runId: string): Promise<IntentFilterResult> {
  const patterns = getConfigOr<string[]>('intent_filter_forum_qa_patterns', DEFAULT_FORUM_QA_PATTERNS);
  if (!Array.isArray(patterns)) {
    throw new Error('intent_filter_forum_qa_patterns config must be array');
  }

  const db = kwDb();
  const candidates = db
    .prepare(`SELECT id, keyword FROM l1_candidates WHERE run_id=?`)
    .all(runId) as Array<{ id: number; keyword: string }>;

  const byPattern: Record<string, number> = Object.fromEntries(patterns.map((p) => [p, 0]));
  let filteredForumQa = 0;
  let filteredBrand = 0;

  const ins = db.prepare(
    `INSERT OR REPLACE INTO candidate_filters (run_id, candidate_id, filter_kind, pattern, reason)
     VALUES (?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    // 既存filterをclear (idempotent)
    db.prepare(`DELETE FROM candidate_filters WHERE run_id=?`).run(runId);

    // 1) forum_qa
    for (const c of candidates) {
      for (const p of patterns) {
        if (c.keyword.includes(p)) {
          ins.run(
            runId,
            c.id,
            'forum_qa',
            p,
            `forum/Q&A intent (matched "${p}") — SEO記事化対象外`,
          );
          byPattern[p] = (byPattern[p] ?? 0) + 1;
          filteredForumQa++;
          break;
        }
      }
    }

    // 2) brand: brand軸を持つ全候補
    const brandRows = db
      .prepare(
        `SELECT DISTINCT ca.candidate_id, ca.axis_value FROM candidate_axes ca
         JOIN l1_candidates lc ON lc.id=ca.candidate_id
         WHERE lc.run_id=? AND ca.axis='brand'`,
      )
      .all(runId) as Array<{ candidate_id: number; axis_value: string }>;
    for (const r of brandRows) {
      // 既に forum_qa で filtered なら skip (重複避け)
      const existing = db
        .prepare(
          `SELECT 1 FROM candidate_filters WHERE run_id=? AND candidate_id=? AND filter_kind='forum_qa'`,
        )
        .get(runId, r.candidate_id);
      if (existing) continue;
      ins.run(
        runId,
        r.candidate_id,
        'brand',
        r.axis_value,
        `competitor brand "${r.axis_value}" — 自社silo target外`,
      );
      filteredBrand++;
    }
  })();

  audit({
    actor: 'system',
    eventType: 'intent_filter.complete',
    entityType: 'run',
    entityId: runId,
    after: { filteredForumQa, filteredBrand, byPattern },
  });

  logger.info(
    { runId, candidatesTotal: candidates.length, filteredForumQa, filteredBrand },
    '[filter] forum/QA + brand',
  );

  return {
    patterns,
    candidatesTotal: candidates.length,
    filteredForumQa,
    filteredBrand,
    filteredTotal: filteredForumQa + filteredBrand,
    byPattern,
  };
}
