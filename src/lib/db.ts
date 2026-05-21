import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { env } from './env.js';

export type DB = Database.Database;

function openDb(path: string): DB {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new Database(abs);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}

let _kwDb: DB | undefined;
export function kwDb(): DB {
  if (!_kwDb) _kwDb = openDb(env.DB_PATH);
  return _kwDb;
}

let _voyageCache: DB | undefined;
export function voyageCacheDb(): DB {
  if (!_voyageCache) _voyageCache = openDb(env.SHARED_VOYAGE_CACHE_PATH);
  return _voyageCache;
}

let _serpCache: DB | undefined;
export function serpCacheDb(): DB {
  if (!_serpCache) _serpCache = openDb(env.SHARED_SERP_CACHE_PATH);
  return _serpCache;
}

export function closeAll(): void {
  _kwDb?.close();
  _voyageCache?.close();
  _serpCache?.close();
  _kwDb = undefined;
  _voyageCache = undefined;
  _serpCache = undefined;
}
