/**
 * Voyage AI embeddings client（voyage-3-large / 1024次元）。
 * 共有キャッシュ (env.SHARED_VOYAGE_CACHE_PATH) を必ず経由する＝二重保持しない。
 *
 * cannibalization-system の lib/voyage.ts と互換のBLOB形式 (Float32Array LE buffer)。
 */
import { fetch } from 'undici';
import { env } from './env.js';
import { voyageCacheDb } from './db.js';
import { sha256Hex } from './normalize.js';

export const VOYAGE_MODEL = 'voyage-3-large';
export const VOYAGE_DIM = 1024;

export type InputType = 'document' | 'query';

interface EmbedApiResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

export function vectorToBlob(vec: number[] | Float32Array): Buffer {
  const f = vec instanceof Float32Array ? vec : new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function blobToVector(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

async function callVoyage(inputs: string[], inputType: InputType): Promise<EmbedApiResponse> {
  if (!env.VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY is not set');
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: inputs, input_type: inputType }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Voyage API ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as EmbedApiResponse;
}

/**
 * Embed with shared cache hit/miss.
 * Returns vectors aligned to the input array.
 */
export async function embed(
  inputs: string[],
  inputType: InputType = 'document',
): Promise<{ vectors: Float32Array[]; tokensUsed: number; cacheHits: number }> {
  if (inputs.length === 0) return { vectors: [], tokensUsed: 0, cacheHits: 0 };

  const cacheDb = voyageCacheDb();
  const getStmt = cacheDb.prepare(
    'SELECT embedding FROM voyage_embeddings WHERE content_hash=? AND model=? AND input_type=?',
  );
  const touchStmt = cacheDb.prepare(
    "UPDATE voyage_embeddings SET last_used_at=strftime('%s','now') WHERE content_hash=? AND model=? AND input_type=?",
  );
  const insertStmt = cacheDb.prepare(
    `INSERT OR IGNORE INTO voyage_embeddings
       (content_hash, model, input_type, dim, embedding, tokens, source_app)
     VALUES (?, ?, ?, ?, ?, ?, 'kw')`,
  );

  const hashes = inputs.map((s) => sha256Hex(s));
  const results: (Float32Array | null)[] = inputs.map(() => null);
  const misses: Array<{ idx: number; text: string; hash: string }> = [];
  let cacheHits = 0;

  for (let i = 0; i < inputs.length; i++) {
    const row = getStmt.get(hashes[i], VOYAGE_MODEL, inputType) as
      | { embedding: Buffer }
      | undefined;
    if (row) {
      results[i] = blobToVector(row.embedding);
      touchStmt.run(hashes[i], VOYAGE_MODEL, inputType);
      cacheHits++;
    } else {
      misses.push({ idx: i, text: inputs[i]!, hash: hashes[i]! });
    }
  }

  let tokensUsed = 0;
  if (misses.length > 0) {
    const resp = await callVoyage(
      misses.map((m) => m.text),
      inputType,
    );
    tokensUsed = resp.usage.total_tokens;
    const ordered = [...resp.data].sort((a, b) => a.index - b.index);
    for (let i = 0; i < misses.length; i++) {
      const vec = new Float32Array(ordered[i]!.embedding);
      results[misses[i]!.idx] = vec;
      insertStmt.run(
        misses[i]!.hash,
        VOYAGE_MODEL,
        inputType,
        VOYAGE_DIM,
        vectorToBlob(vec),
        Math.round(tokensUsed / misses.length),
      );
    }
  }

  return {
    vectors: results.map((v) => v!),
    tokensUsed,
    cacheHits,
  };
}
