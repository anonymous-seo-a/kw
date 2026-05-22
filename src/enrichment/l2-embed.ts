/**
 * [L2] 全L1候補に Voyage embedding を付与する。
 * Vector本体は共有Voyageキャッシュに保存され、l2_embeddings は content_hash 参照のみ持つ。
 */
import { kwDb } from '../lib/db.js';
import { embed, VOYAGE_MODEL, VOYAGE_DIM } from '../lib/voyage.js';
import { sha256Hex } from '../lib/normalize.js';
import { logger } from '../lib/logger.js';

export interface L2EmbedResult {
  embedded: number;
  cacheHits: number;
  tokensUsed: number;
}

const BATCH = 16;

export async function ingestL2Embeddings(runId: string): Promise<L2EmbedResult> {
  const db = kwDb();
  const candidates = db
    .prepare('SELECT id, keyword FROM l1_candidates WHERE run_id=? ORDER BY id')
    .all(runId) as Array<{ id: number; keyword: string }>;

  if (candidates.length === 0) return { embedded: 0, cacheHits: 0, tokensUsed: 0 };

  const insert = db.prepare(
    `INSERT INTO l2_embeddings (candidate_id, content_hash, model, dim, input_type)
     VALUES (?, ?, ?, ?, 'document')
     ON CONFLICT(candidate_id) DO UPDATE SET
       content_hash=excluded.content_hash,
       model=excluded.model,
       dim=excluded.dim,
       created_at=strftime('%s','now')`,
  );

  let embedded = 0;
  let cacheHits = 0;
  let tokensUsed = 0;

  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    const inputs = slice.map((c) => c.keyword);
    const r = await embed(inputs, 'document');
    cacheHits += r.cacheHits;
    tokensUsed += r.tokensUsed;

    db.transaction(() => {
      for (let j = 0; j < slice.length; j++) {
        insert.run(slice[j]!.id, sha256Hex(inputs[j]!), VOYAGE_MODEL, VOYAGE_DIM);
        embedded++;
      }
    })();
    logger.info(
      { runId, batchIdx: Math.floor(i / BATCH), size: slice.length, cacheHits: r.cacheHits },
      '[L2] embed batch',
    );
  }

  return { embedded, cacheHits, tokensUsed };
}
