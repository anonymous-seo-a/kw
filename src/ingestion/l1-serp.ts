/**
 * [L1] SerpAPI 経由で seed/関連クエリの PAA・関連検索・サジェスト を取得。
 *
 * 注意: ここで取れる候補は「同じ意図群に並ぶ語」≒ サイロ拡張の素材。
 * 取得は全て共有 SERP キャッシュ経由（二重保持禁止）。
 */
import { googleSearch, googleAutocomplete } from '../lib/serpapi.js';
import { logger } from '../lib/logger.js';
import { logSourceEvent, upsertCandidates, type IncomingCandidate } from './candidates.js';

export interface SerpL1Options {
  seedKw: string;
  /** 追加で叩く派生クエリ（fanout結果や handful of seeds）。空ならseedのみ。 */
  derivedQueries?: string[];
  gl?: string;
  hl?: string;
}

interface PaaItem {
  question?: string;
  snippet?: string;
}
interface RelatedItem {
  query?: string;
}
interface AutocompleteItem {
  value?: string;
}

function extractFromGoogle(raw: any): {
  paa: string[];
  related: string[];
} {
  const paa = ((raw['related_questions'] as PaaItem[] | undefined) ?? [])
    .map((q) => (q.question ?? '').trim())
    .filter(Boolean);
  const related = ((raw['related_searches'] as RelatedItem[] | undefined) ?? [])
    .map((q) => (q.query ?? '').trim())
    .filter(Boolean);
  return { paa, related };
}

function extractFromAutocomplete(raw: any): string[] {
  const suggs = (raw['suggestions'] as AutocompleteItem[] | undefined) ?? [];
  return suggs.map((s) => (s.value ?? '').trim()).filter(Boolean);
}

export async function ingestSerpL1(
  runId: string,
  opts: SerpL1Options,
): Promise<{ paa: number; related: number; autocomplete: number }> {
  const queries = [opts.seedKw, ...(opts.derivedQueries ?? [])];
  const seen = new Set<string>();
  const uniqueQueries = queries.filter((q) => {
    const k = q.trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  let paaCount = 0;
  let relatedCount = 0;
  let acCount = 0;

  for (const q of uniqueQueries) {
    // 1) google search → PAA + related_searches + (organic_results は [L2] 用にキャッシュ済)
    try {
      const r = await googleSearch(q, { gl: opts.gl, hl: opts.hl });
      const { paa, related } = extractFromGoogle(r.raw);
      logSourceEvent(runId, 'serpapi_google', q, {
        cacheKey: r.cacheKey,
        fromCache: r.fromCache,
        paaCount: paa.length,
        relatedCount: related.length,
      });
      const incoming: IncomingCandidate[] = [
        ...paa.map<IncomingCandidate>((k) => ({
          keyword: k,
          source: { provider: 'serpapi_paa', meta: { from: q, cacheKey: r.cacheKey } },
        })),
        ...related.map<IncomingCandidate>((k) => ({
          keyword: k,
          source: { provider: 'serpapi_related', meta: { from: q, cacheKey: r.cacheKey } },
        })),
      ];
      const { inserted } = upsertCandidates(runId, incoming);
      paaCount += paa.length;
      relatedCount += related.length;
      logger.info({ q, paa: paa.length, related: related.length, inserted }, '[L1] serpapi google');
    } catch (e) {
      logger.error({ q, err: (e as Error).message }, '[L1] serpapi google failed');
    }

    // 2) autocomplete
    try {
      const r = await googleAutocomplete(q, { gl: opts.gl, hl: opts.hl });
      const sugg = extractFromAutocomplete(r.raw);
      logSourceEvent(runId, 'serpapi_autocomplete', q, {
        cacheKey: r.cacheKey,
        fromCache: r.fromCache,
        suggestionCount: sugg.length,
      });
      const incoming: IncomingCandidate[] = sugg.map((k) => ({
        keyword: k,
        source: { provider: 'serpapi_autocomplete', meta: { from: q, cacheKey: r.cacheKey } },
      }));
      const { inserted } = upsertCandidates(runId, incoming);
      acCount += sugg.length;
      logger.info({ q, suggestions: sugg.length, inserted }, '[L1] serpapi autocomplete');
    } catch (e) {
      logger.error({ q, err: (e as Error).message }, '[L1] serpapi autocomplete failed');
    }
  }

  return { paa: paaCount, related: relatedCount, autocomplete: acCount };
}
