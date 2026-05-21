/**
 * Candidate KW merger for [L1].
 * 出所タグを重畳して 1 (run_id, keyword_norm) = 1行 にまとめる。
 */
import { kwDb } from '../lib/db.js';
import { normalizeKeyword } from '../lib/normalize.js';

export interface CandidateSource {
  provider: string; // 'gsc' | 'llm_fanout' | 'serpapi_paa' | 'serpapi_related' | 'serpapi_autocomplete' | 'google_nlp'
  meta?: Record<string, unknown>;
}

export interface IncomingCandidate {
  keyword: string;
  source: CandidateSource;
}

/**
 * Insert or update candidates, merging sources by keyword_norm.
 * Returns counts {inserted, mergedSources}.
 */
export function upsertCandidates(
  runId: string,
  candidates: IncomingCandidate[],
): { inserted: number; mergedSources: number } {
  const db = kwDb();
  let inserted = 0;
  let mergedSources = 0;

  const get = db.prepare(
    'SELECT id, sources_json FROM l1_candidates WHERE run_id=? AND keyword_norm=?',
  );
  const ins = db.prepare(
    `INSERT INTO l1_candidates (run_id, keyword, keyword_norm, sources_json)
     VALUES (?, ?, ?, ?)`,
  );
  const upd = db.prepare('UPDATE l1_candidates SET sources_json=? WHERE id=?');

  const tx = db.transaction(() => {
    // dedup within this batch by keyword_norm
    const grouped = new Map<string, { keyword: string; sources: CandidateSource[] }>();
    for (const c of candidates) {
      const trimmed = c.keyword.trim();
      if (!trimmed) continue;
      const norm = normalizeKeyword(trimmed);
      if (!norm) continue;
      const cur = grouped.get(norm);
      if (cur) {
        cur.sources.push(c.source);
      } else {
        grouped.set(norm, { keyword: trimmed, sources: [c.source] });
      }
    }

    for (const [norm, payload] of grouped) {
      const row = get.get(runId, norm) as { id: number; sources_json: string } | undefined;
      if (row) {
        const merged = [
          ...(JSON.parse(row.sources_json) as CandidateSource[]),
          ...payload.sources,
        ];
        upd.run(JSON.stringify(merged), row.id);
        mergedSources++;
      } else {
        ins.run(runId, payload.keyword, norm, JSON.stringify(payload.sources));
        inserted++;
      }
    }
  });
  tx();
  return { inserted, mergedSources };
}

export function logSourceEvent(
  runId: string,
  provider: string,
  inputQuery: string | null,
  raw: unknown,
): void {
  kwDb()
    .prepare(
      'INSERT INTO l1_source_events (run_id, provider, input_query, raw_json) VALUES (?, ?, ?, ?)',
    )
    .run(runId, provider, inputQuery, JSON.stringify(raw));
}
