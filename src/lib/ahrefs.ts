/**
 * Ahrefs API v3 thin client.
 *
 * 仕様 revision (2026-05-22): [L1]で Ahrefs を使用可。理由:
 *   - Daiki指摘: GoogleのPAA/related/autocomplete だけだと single-source bias になり、
 *     ブランド名・地域・情報系などの dimension が痩せる。Ahrefs サジェストの方が信頼性高。
 *   - 月150,000ユニット予算で seed × 4 endpoint × 200 rows ≒ 8,000ユニット (5%) で収まる。
 *   - 予算超過は ahrefs-budget の assertAvailable() で自動停止。
 *
 * unit 計算: x-api-units-cost-total-actual ヘッダで実消費を取得し consume() に渡す。
 */
import { fetch } from 'undici';
import { env } from './env.js';
import { assertAvailable, consume, estimateUnits, BudgetExceededError } from './ahrefs-budget.js';

const BASE = 'https://api.ahrefs.com/v3';

export interface AhrefsKeywordRow {
  keyword: string;
  volume?: number | null;
  difficulty?: number | null;
  cpc?: number | null;
  intents?: string[] | null;
  cps?: number | null;
}

export type AhrefsEndpointKind =
  | 'matching-terms'
  | 'related-terms'
  | 'matching-terms-questions'   // matching-terms with terms=questions filter
  | 'search-suggestions';

interface CallOptions {
  endpoint: AhrefsEndpointKind;
  keyword: string;
  country?: string;
  searchEngine?: string;
  limit?: number;
  select?: string[];
  /** Pre-check the budget before calling (default true). */
  assertBudget?: boolean;
  runId?: string;
}

const PATH_MAP: Record<AhrefsEndpointKind, { path: string; extraParams: Record<string, string> }> = {
  'matching-terms': { path: 'keywords-explorer/matching-terms', extraParams: {} },
  'related-terms': { path: 'keywords-explorer/related-terms', extraParams: {} },
  'matching-terms-questions': {
    path: 'keywords-explorer/matching-terms',
    extraParams: { terms: 'questions' },
  },
  'search-suggestions': { path: 'keywords-explorer/search-suggestions', extraParams: {} },
};

const DEFAULT_SELECT = ['keyword', 'volume', 'difficulty', 'cpc', 'intents'];

export interface AhrefsCallResult {
  endpoint: AhrefsEndpointKind;
  rows: AhrefsKeywordRow[];
  unitsEstimated: number;
  unitsActual: number;
}

export async function callAhrefs(opts: CallOptions): Promise<AhrefsCallResult> {
  if (!env.AHREFS_API_TOKEN) throw new Error('AHREFS_API_TOKEN is not set');

  const limit = opts.limit ?? 200;
  const select = (opts.select ?? DEFAULT_SELECT).join(',');
  const estimate = estimateUnits({
    endpoint: opts.endpoint,
    rowCount: limit,
    fields: (opts.select ?? DEFAULT_SELECT).length,
  });

  if (opts.assertBudget !== false) {
    assertAvailable(estimate, opts.endpoint);
  }

  const m = PATH_MAP[opts.endpoint];
  const url = new URL(`${BASE}/${m.path}`);
  url.searchParams.set('country', opts.country ?? 'jp');
  url.searchParams.set('search_engine', opts.searchEngine ?? 'google');
  url.searchParams.set('keywords', opts.keyword);
  url.searchParams.set('select', select);
  url.searchParams.set('limit', String(limit));
  for (const [k, v] of Object.entries(m.extraParams)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${env.AHREFS_API_TOKEN}`,
      Accept: 'application/json',
    },
  });

  const unitsActual = Number(res.headers.get('x-api-units-cost-total-actual') ?? res.headers.get('x-api-units-cost-total') ?? estimate);

  if (!res.ok) {
    const body = await res.text();
    // 課金は発生していない想定 (4xx)、ただし unit ヘッダがあれば記録
    if (unitsActual > 0) {
      try {
        consume({
          endpoint: opts.endpoint,
          estimated: estimate,
          actual: unitsActual,
          runId: opts.runId,
          request: { keyword: opts.keyword, limit, select },
          responseMeta: { status: res.status, error: body.slice(0, 300) },
        });
      } catch {
        /* noop */
      }
    }
    throw new Error(`Ahrefs ${opts.endpoint} ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as { keywords?: AhrefsKeywordRow[] };
  const rows = json.keywords ?? [];

  consume({
    endpoint: opts.endpoint,
    estimated: estimate,
    actual: unitsActual,
    runId: opts.runId,
    request: { keyword: opts.keyword, limit, select },
    responseMeta: { rows: rows.length, status: res.status },
  });

  return { endpoint: opts.endpoint, rows, unitsEstimated: estimate, unitsActual };
}

export { BudgetExceededError };
