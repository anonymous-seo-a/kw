/**
 * 意図フィルタ: SEO記事化しないKWを除外する仕組み。
 *
 *  - forum_qa: 知恵袋 / 2ch / 5ch / 掲示板 / なんJ / まとめサイト 等
 *    (これらは ユーザが「フォーラム/Q&Aサイトを探す」意図でありメディア記事の対象外)
 *
 * 設定:
 *   config 'intent_filter_forum_qa_patterns' (string[]) で patterns を上書き可。
 *   default は下記 DEFAULT_FORUM_QA_PATTERNS。
 *
 * 効果:
 *   - candidate_filters に記録 (kind='forum_qa')
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
  let filtered = 0;

  const ins = db.prepare(
    `INSERT OR REPLACE INTO candidate_filters (run_id, candidate_id, filter_kind, pattern, reason)
     VALUES (?, ?, 'forum_qa', ?, ?)`,
  );

  db.transaction(() => {
    // 既存filterをclear (idempotent)
    db.prepare(`DELETE FROM candidate_filters WHERE run_id=? AND filter_kind='forum_qa'`).run(
      runId,
    );
    for (const c of candidates) {
      const kw = c.keyword;
      for (const p of patterns) {
        if (kw.includes(p)) {
          ins.run(
            runId,
            c.id,
            p,
            `forum/Q&A intent (matched "${p}") — SEO記事化対象外`,
          );
          byPattern[p] = (byPattern[p] ?? 0) + 1;
          filtered++;
          break; // 1KW 1 reason
        }
      }
    }
  })();

  audit({
    actor: 'system',
    eventType: 'intent_filter.complete',
    entityType: 'run',
    entityId: runId,
    after: { patterns: patterns.length, filteredTotal: filtered, byPattern },
  });

  logger.info({ runId, candidatesTotal: candidates.length, filteredTotal: filtered, byPattern }, '[filter] forum/QA');

  return {
    patterns,
    candidatesTotal: candidates.length,
    filteredTotal: filtered,
    byPattern,
  };
}
