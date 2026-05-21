/**
 * [L1] 統合実行: GSC → LLM fanout → SerpAPI (seed + fanout) → Google NLP (seed + fanout)
 *
 * Ahrefs は使用しない（仕様: [L1]ではAhrefs禁止）。
 * 並列はせず順に走らせる（API kost抑制 & ログ可読性）。
 */
import { logger } from '../lib/logger.js';
import { setRunStatus } from '../lib/runs.js';
import { kwDb } from '../lib/db.js';
import { ingestGscL1 } from './l1-gsc.js';
import { ingestFanout } from './l1-fanout.js';
import { ingestSerpL1 } from './l1-serp.js';
import { ingestNlpL1 } from './l1-nlp.js';

export interface L1RunOptions {
  runId: string;
  seedKw: string;
  vertical?: string | null;
  /** Skips for selective re-run. */
  skip?: { gsc?: boolean; fanout?: boolean; serp?: boolean; nlp?: boolean };
}

export async function runL1(opts: L1RunOptions): Promise<{
  candidates: number;
  byProvider: Record<string, number>;
  entitiesTotal: number;
}> {
  setRunStatus(opts.runId, 'l1');
  const { runId, seedKw, vertical } = opts;
  const skip = opts.skip ?? {};

  // 1) GSC (greenfield なら空。失敗してもスキップ)
  let gscRows = 0;
  if (!skip.gsc) {
    const r = await ingestGscL1(runId, { seedKw });
    gscRows = r.rows;
  }

  // 2) LLM fanout
  let fanoutSubqueries: string[] = [];
  if (!skip.fanout) {
    await ingestFanout(runId, { seedKw, vertical: vertical ?? undefined });
    // 取り出して以降のSerp/NLPの種にする
    fanoutSubqueries = (
      kwDb()
        .prepare(
          `SELECT keyword FROM l1_candidates WHERE run_id=? AND
            json_extract(sources_json, '$[0].provider') = 'llm_fanout'`,
        )
        .all(runId) as Array<{ keyword: string }>
    ).map((r) => r.keyword);
  }

  // 3) SerpAPI: seed + fanout（重い順序ではあるが PAA/related/autocompleteは無料相当）
  let serpStats = { paa: 0, related: 0, autocomplete: 0 };
  if (!skip.serp) {
    serpStats = await ingestSerpL1(runId, { seedKw, derivedQueries: fanoutSubqueries });
  }

  // 4) Google NLP: seed + fanout
  let entitiesTotal = 0;
  if (!skip.nlp) {
    const r = await ingestNlpL1(runId, { seedKw, additionalQueries: fanoutSubqueries });
    entitiesTotal = r.entitiesTotal;
  }

  // Final counts
  const candidates = (
    kwDb().prepare('SELECT COUNT(*) AS n FROM l1_candidates WHERE run_id=?').get(runId) as {
      n: number;
    }
  ).n;

  const byProviderRows = kwDb()
    .prepare(
      `SELECT json_each.value->>'provider' AS provider, COUNT(*) AS n
       FROM l1_candidates, json_each(l1_candidates.sources_json)
       WHERE run_id=?
       GROUP BY provider
       ORDER BY n DESC`,
    )
    .all(runId) as Array<{ provider: string; n: number }>;
  const byProvider: Record<string, number> = {};
  for (const r of byProviderRows) byProvider[r.provider] = r.n;

  logger.info(
    { runId, candidates, byProvider, gscRows, serpStats, entitiesTotal },
    '[L1] complete',
  );
  setRunStatus(opts.runId, 'l1_done');
  return { candidates, byProvider, entitiesTotal };
}
