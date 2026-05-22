/**
 * [L2] 全L1候補の SERPフィンガープリント取得。
 * - googleSearch() は共有SERPキャッシュ経由。キャッシュヒットなら追加コスト無し。
 * - 取得済み上位URL本体は shared.serp_top_urls にあり、ここは cache_key 参照のみ。
 */
import { kwDb, serpCacheDb } from '../lib/db.js';
import { googleSearch } from '../lib/serpapi.js';
import { logger } from '../lib/logger.js';

export interface L2SerpFpResult {
  candidatesTotal: number;
  cacheHits: number;
  newFetches: number;
  failed: number;
}

const TOP_N = 10;

export async function ingestL2SerpFingerprints(runId: string): Promise<L2SerpFpResult> {
  const db = kwDb();
  const candidates = db
    .prepare('SELECT id, keyword FROM l1_candidates WHERE run_id=? ORDER BY id')
    .all(runId) as Array<{ id: number; keyword: string }>;

  const insert = db.prepare(
    `INSERT INTO l2_serp_fp (candidate_id, cache_key, top_n, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(candidate_id) DO UPDATE SET
       cache_key=excluded.cache_key,
       top_n=excluded.top_n,
       fetched_at=excluded.fetched_at`,
  );
  const countTopStmt = serpCacheDb().prepare(
    'SELECT COUNT(*) AS n FROM serp_top_urls WHERE cache_key=?',
  );

  let cacheHits = 0;
  let newFetches = 0;
  let failed = 0;

  for (const c of candidates) {
    try {
      const r = await googleSearch(c.keyword, { num: TOP_N });
      if (r.fromCache) cacheHits++;
      else newFetches++;
      const topCount = (countTopStmt.get(r.cacheKey) as { n: number }).n;
      insert.run(c.id, r.cacheKey, topCount, r.fetchedAt);
    } catch (e) {
      failed++;
      logger.error({ candidateId: c.id, err: (e as Error).message }, '[L2] serp-fp failed');
    }
  }

  logger.info(
    { runId, candidatesTotal: candidates.length, cacheHits, newFetches, failed },
    '[L2] serp-fp done',
  );
  return { candidatesTotal: candidates.length, cacheHits, newFetches, failed };
}
