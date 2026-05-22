/**
 * [L1] Ahrefs Keywords Explorer 4 エンドポイントから候補KWを取得。
 *
 * 仕様revision (2026-05-22 / Daiki合意): Ahrefsを[L1]で使用可。
 *   理由: Google単一ソース依存を解消し、ブランド名/地域/情報系の dimension を拾う。
 *
 * 呼ぶエンドポイント:
 *   1. matching-terms              (broad lexical)
 *   2. related-terms               (semantic related)
 *   3. matching-terms-questions    (terms=questions filter)
 *   4. search-suggestions          (autocomplete proxy)
 *
 * 全件 ahrefs_budget の assertAvailable() → consume() を通すので予算超過は自動停止。
 */
import { callAhrefs, type AhrefsEndpointKind } from '../lib/ahrefs.js';
import { logger } from '../lib/logger.js';
import { logSourceEvent, upsertCandidates, type IncomingCandidate } from './candidates.js';
import { BudgetExceededError } from '../lib/ahrefs-budget.js';

export interface AhrefsL1Options {
  seedKw: string;
  country?: string;
  /** rows per endpoint */
  limit?: number;
  /** どのendpointを使うか (省略で4つ全部) */
  endpoints?: AhrefsEndpointKind[];
}

export interface AhrefsL1Result {
  byEndpoint: Record<string, { rows: number; unitsActual: number }>;
  inserted: number;
  unitsTotal: number;
  budgetExceeded?: { endpoint: string; requested: number; available: number };
}

const DEFAULT_ENDPOINTS: AhrefsEndpointKind[] = [
  'matching-terms',
  'related-terms',
  'matching-terms-questions',
  'search-suggestions',
];

const PROVIDER_NAME: Record<AhrefsEndpointKind, string> = {
  'matching-terms': 'ahrefs_matching_terms',
  'related-terms': 'ahrefs_related_terms',
  'matching-terms-questions': 'ahrefs_questions',
  'search-suggestions': 'ahrefs_search_suggestions',
};

export async function ingestAhrefsL1(
  runId: string,
  opts: AhrefsL1Options,
): Promise<AhrefsL1Result> {
  const endpoints = opts.endpoints ?? DEFAULT_ENDPOINTS;
  const limit = opts.limit ?? 200;
  const byEndpoint: Record<string, { rows: number; unitsActual: number }> = {};
  let inserted = 0;
  let unitsTotal = 0;

  for (const ep of endpoints) {
    try {
      const r = await callAhrefs({
        endpoint: ep,
        keyword: opts.seedKw,
        country: opts.country,
        limit,
        runId,
      });
      byEndpoint[ep] = { rows: r.rows.length, unitsActual: r.unitsActual };
      unitsTotal += r.unitsActual;
      logSourceEvent(runId, PROVIDER_NAME[ep], opts.seedKw, {
        rows: r.rows.length,
        unitsActual: r.unitsActual,
      });

      const incoming: IncomingCandidate[] = r.rows
        .map((row) => (row.keyword ?? '').trim())
        .filter(Boolean)
        .map<IncomingCandidate>((kw) => ({
          keyword: kw,
          source: { provider: PROVIDER_NAME[ep], meta: { from: opts.seedKw, endpoint: ep } },
        }));
      const ins = upsertCandidates(runId, incoming);
      inserted += ins.inserted;
      logger.info(
        { runId, endpoint: ep, rows: r.rows.length, inserted: ins.inserted, units: r.unitsActual },
        '[L1] ahrefs',
      );
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        logger.error(
          { runId, endpoint: ep, requested: e.requested, available: e.available },
          '[L1] ahrefs budget exceeded — stopping',
        );
        return {
          byEndpoint,
          inserted,
          unitsTotal,
          budgetExceeded: { endpoint: ep, requested: e.requested, available: e.available },
        };
      }
      logger.error({ runId, endpoint: ep, err: (e as Error).message }, '[L1] ahrefs failed');
    }
  }

  return { byEndpoint, inserted, unitsTotal };
}
