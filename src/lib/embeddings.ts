/**
 * Vector loader: kw.l2_embeddings (content_hash参照) → shared voyage_embeddings (vector本体)。
 * 二重保持しない設計上、cross-DB joinを避けて2-step lookupで取得する。
 */
import { kwDb, voyageCacheDb } from './db.js';
import { blobToVector, VOYAGE_MODEL } from './voyage.js';
import { sha256Hex } from './normalize.js';

export interface CandidateVector {
  candidateId: number;
  keyword: string;
  vector: Float32Array;
}

/**
 * Returns vectors for all L1 candidates of a run that have l2_embeddings rows.
 * Missing vectors (cache miss / unembedded) are silently omitted.
 */
export function loadRunVectors(runId: string): CandidateVector[] {
  const refs = kwDb()
    .prepare(
      `SELECT lc.id AS candidate_id, lc.keyword, le.content_hash, le.model, le.input_type
       FROM l2_embeddings le
       JOIN l1_candidates lc ON lc.id = le.candidate_id
       WHERE lc.run_id = ?
       ORDER BY lc.id`,
    )
    .all(runId) as Array<{
    candidate_id: number;
    keyword: string;
    content_hash: string;
    model: string;
    input_type: string;
  }>;

  if (refs.length === 0) return [];

  const stmt = voyageCacheDb().prepare(
    'SELECT embedding FROM voyage_embeddings WHERE content_hash=? AND model=? AND input_type=?',
  );

  const out: CandidateVector[] = [];
  for (const r of refs) {
    const row = stmt.get(r.content_hash, r.model, r.input_type) as
      | { embedding: Buffer }
      | undefined;
    if (!row) continue;
    out.push({
      candidateId: r.candidate_id,
      keyword: r.keyword,
      vector: blobToVector(row.embedding),
    });
  }
  return out;
}

/**
 * Compute centroid (arithmetic mean) of a vector set. Returns a unit-normalized vector.
 */
export function centroid(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) throw new Error('centroid: empty vector set');
  const dim = vectors[0]!.length;
  const sum = new Float32Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i]! += v[i]!;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    sum[i] = sum[i]! / vectors.length;
    norm += sum[i]! * sum[i]!;
  }
  const inv = 1 / (Math.sqrt(norm) + 1e-12);
  for (let i = 0; i < dim; i++) sum[i] = sum[i]! * inv;
  return sum;
}

/**
 * Resolve an embedded vector for an arbitrary text via shared voyage cache
 * (only returns if previously embedded; does not call Voyage API).
 */
export function getCachedVector(text: string, model: string = VOYAGE_MODEL): Float32Array | undefined {
  const hash = sha256Hex(text);
  const row = voyageCacheDb()
    .prepare('SELECT embedding FROM voyage_embeddings WHERE content_hash=? AND model=? AND input_type=?')
    .get(hash, model, 'document') as { embedding: Buffer } | undefined;
  return row ? blobToVector(row.embedding) : undefined;
}
