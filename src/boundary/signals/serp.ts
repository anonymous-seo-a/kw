/**
 * SERP由来信号: 領域内クエリの上位ページに出現するエンティティ集合 (≒必然性フロア)。
 *
 * 完全実装はSERP本文をNLPに通してエンティティ抽出するが、creds/コストが重い。
 * パイロット実装:
 *   - 領域内クエリ (density signal で in-region 判定された候補) のSERP top10 を取得
 *   - 同一URLが in-region クエリ間で N (=serp_overlap_n) 以上の頻度で出現するなら
 *     「在地で繰り返し露出するURL/ドメイン」= SERP由来の必然性フロアと見なす
 *   - そのURL/ドメインを SERP-derived entity として記録 (entity_key='url:<url>')
 *
 * NLP creds 配置後は serp_results.result_json のtitle+snippetを analyzeEntities() に通して
 * entity ベースで記録すべき (TODO)。
 */
import { kwDb, serpCacheDb } from '../../lib/db.js';
import { thresholds } from '../thresholds.js';
import { logger } from '../../lib/logger.js';

export interface SerpSignalResult {
  serpOverlapN: number;
  inRegionQueries: number;
  uniqueUrls: number;
  floorUrls: number; // ≥N回出現したURL数
  floorDomains: number;
}

interface UrlRow {
  cache_key: string;
  url: string;
  domain: string | null;
  rank: number;
}

export async function buildSerpSignal(runId: string): Promise<SerpSignalResult> {
  const th = thresholds().serpOverlapN;

  // density signalで in-region と判定された候補 → l2_serp_fp → shared.serp_top_urls
  const densityCandidates = kwDb()
    .prepare(
      `SELECT json_extract(source_meta_json, '$.candidateId') AS candidate_id
       FROM boundary_signals
       WHERE run_id=? AND signal_kind='density'`,
    )
    .all(runId) as Array<{ candidate_id: number }>;

  if (densityCandidates.length === 0) {
    logger.warn({ runId }, '[B] serp signal: no in-region candidates (density empty)');
    return { serpOverlapN: th, inRegionQueries: 0, uniqueUrls: 0, floorUrls: 0, floorDomains: 0 };
  }

  // cache_keys for in-region candidates
  const candidateIds = densityCandidates.map((d) => d.candidate_id).filter((x): x is number => typeof x === 'number');
  const placeholders = candidateIds.map(() => '?').join(',');
  const fpRows = kwDb()
    .prepare(`SELECT candidate_id, cache_key FROM l2_serp_fp WHERE candidate_id IN (${placeholders})`)
    .all(...candidateIds) as Array<{ candidate_id: number; cache_key: string }>;
  if (fpRows.length === 0) {
    return {
      serpOverlapN: th,
      inRegionQueries: 0,
      uniqueUrls: 0,
      floorUrls: 0,
      floorDomains: 0,
    };
  }
  const cacheKeys = [...new Set(fpRows.map((r) => r.cache_key))];

  // shared serp_top_urls からURL一覧
  const cKeyPh = cacheKeys.map(() => '?').join(',');
  const urlRows = serpCacheDb()
    .prepare(`SELECT cache_key, rank, url, domain FROM serp_top_urls WHERE cache_key IN (${cKeyPh})`)
    .all(...cacheKeys) as UrlRow[];

  // URL頻度 (cache_keyごとに1カウントする): 同じURL内で複数rank≒同サイトの重複は1カウント
  // → URL × cache_key の組で uniq → URLごとの出現 cache_key 数を数える
  const urlOccur = new Map<string, Set<string>>(); // url → cache_keys
  const domainOccur = new Map<string, Set<string>>(); // domain → cache_keys
  for (const r of urlRows) {
    if (!urlOccur.has(r.url)) urlOccur.set(r.url, new Set());
    urlOccur.get(r.url)!.add(r.cache_key);
    if (r.domain) {
      if (!domainOccur.has(r.domain)) domainOccur.set(r.domain, new Set());
      domainOccur.get(r.domain)!.add(r.cache_key);
    }
  }

  // ≥N回出現するURL/ドメイン
  const floorUrls: Array<{ url: string; count: number; domain?: string }> = [];
  for (const [url, keys] of urlOccur) {
    if (keys.size >= th) {
      const row = urlRows.find((r) => r.url === url);
      floorUrls.push({ url, count: keys.size, domain: row?.domain ?? undefined });
    }
  }
  const floorDomains: Array<{ domain: string; count: number }> = [];
  for (const [domain, keys] of domainOccur) {
    if (keys.size >= th) floorDomains.push({ domain, count: keys.size });
  }

  // 永続化
  const db = kwDb();
  const insert = db.prepare(
    `INSERT INTO boundary_signals (run_id, signal_kind, entity_key, entity_name, score, source_meta_json)
     VALUES (?, 'serp', ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.prepare(`DELETE FROM boundary_signals WHERE run_id=? AND signal_kind='serp'`).run(runId);
    for (const f of floorUrls) {
      insert.run(
        runId,
        `url:${f.url}`,
        f.url,
        f.count,
        JSON.stringify({ kind: 'url', occurrences: f.count, domain: f.domain ?? null }),
      );
    }
    for (const d of floorDomains) {
      insert.run(
        runId,
        `domain:${d.domain}`,
        d.domain,
        d.count,
        JSON.stringify({ kind: 'domain', occurrences: d.count }),
      );
    }
  })();

  logger.info(
    {
      runId,
      th,
      inRegionQueries: cacheKeys.length,
      uniqueUrls: urlOccur.size,
      floorUrls: floorUrls.length,
      floorDomains: floorDomains.length,
    },
    '[B] serp signal',
  );

  return {
    serpOverlapN: th,
    inRegionQueries: cacheKeys.length,
    uniqueUrls: urlOccur.size,
    floorUrls: floorUrls.length,
    floorDomains: floorDomains.length,
  };
}
