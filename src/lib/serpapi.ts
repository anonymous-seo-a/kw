/**
 * SerpAPI client — 必ず共有 SERP キャッシュ (env.SHARED_SERP_CACHE_PATH) 経由。
 * 二重保持禁止のため kw 側に独自テーブルは作らない。
 */
import { fetch } from 'undici';
import { env } from './env.js';
import { serpCacheDb } from './db.js';
import { sha256Hex } from './normalize.js';

const SERPAPI_BASE = 'https://serpapi.com/search.json';

export interface SerpRequest {
  engine: string; // 'google' | 'google_autocomplete' | ...
  query: string;
  params?: Record<string, string | number>;
  /** Cache TTL in seconds. undefined = use any age, 0 = bypass cache. */
  ttlSec?: number;
}

export interface SerpResult {
  cacheKey: string;
  fromCache: boolean;
  fetchedAt: number;
  raw: any;
}

function cacheKey(req: SerpRequest): string {
  const canonical = {
    engine: req.engine,
    query: req.query,
    params: req.params ?? {},
  };
  return sha256Hex(JSON.stringify(canonical));
}

export async function serpSearch(req: SerpRequest): Promise<SerpResult> {
  if (!env.SERPAPI_KEY) throw new Error('SERPAPI_KEY is not set');
  const db = serpCacheDb();
  const key = cacheKey(req);

  if (req.ttlSec !== 0) {
    const row = db
      .prepare('SELECT result_json, fetched_at FROM serp_results WHERE cache_key=?')
      .get(key) as { result_json: string; fetched_at: number } | undefined;
    if (row) {
      const ageOk = req.ttlSec === undefined || Date.now() / 1000 - row.fetched_at <= req.ttlSec;
      if (ageOk) {
        return {
          cacheKey: key,
          fromCache: true,
          fetchedAt: row.fetched_at,
          raw: JSON.parse(row.result_json),
        };
      }
    }
  }

  const url = new URL(SERPAPI_BASE);
  url.searchParams.set('engine', req.engine);
  url.searchParams.set('q', req.query);
  url.searchParams.set('api_key', env.SERPAPI_KEY);
  for (const [k, v] of Object.entries(req.params ?? {})) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SerpAPI ${res.status} (${req.engine} q="${req.query}"): ${text.slice(0, 300)}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;

  const organic = (raw['organic_results'] as Array<{ link?: string; title?: string }>) ?? [];

  const fetchedAt = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO serp_results (cache_key, engine, query, params_json, result_json, result_url_count, source_app, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, 'kw', ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         result_json=excluded.result_json,
         result_url_count=excluded.result_url_count,
         fetched_at=excluded.fetched_at`,
    ).run(
      key,
      req.engine,
      req.query,
      JSON.stringify(req.params ?? {}),
      JSON.stringify(raw),
      organic.length,
      fetchedAt,
    );
    if (organic.length > 0) {
      db.prepare('DELETE FROM serp_top_urls WHERE cache_key=?').run(key);
      const ins = db.prepare(
        'INSERT INTO serp_top_urls (cache_key, rank, url, domain, title) VALUES (?, ?, ?, ?, ?)',
      );
      for (let i = 0; i < organic.length; i++) {
        const link = organic[i]!.link;
        if (!link) continue;
        let domain: string | null = null;
        try {
          domain = new URL(link).hostname;
        } catch {
          /* noop */
        }
        ins.run(key, i + 1, link, domain, organic[i]!.title ?? null);
      }
    }
  });
  tx();

  return { cacheKey: key, fromCache: false, fetchedAt, raw };
}

// ----- helpers for [L1] -----

/**
 * Google 検索（オーガニック10件 + PAA + related_searches）。
 * 「AGA おすすめ」のようなseed/derivedクエリで使う。
 */
export async function googleSearch(query: string, opts: { gl?: string; hl?: string; num?: number } = {}) {
  return serpSearch({
    engine: 'google',
    query,
    params: {
      gl: opts.gl ?? 'jp',
      hl: opts.hl ?? 'ja',
      num: opts.num ?? 10,
    },
  });
}

/**
 * Google Autocomplete サジェスト。
 */
export async function googleAutocomplete(query: string, opts: { gl?: string; hl?: string } = {}) {
  return serpSearch({
    engine: 'google_autocomplete',
    query,
    params: {
      gl: opts.gl ?? 'jp',
      hl: opts.hl ?? 'ja',
    },
  });
}
