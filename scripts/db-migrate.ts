/**
 * Apply pending migrations to:
 *   - kw専有 DB        (env.DB_PATH)
 *   - shared voyage    (env.SHARED_VOYAGE_CACHE_PATH)
 *   - shared serp      (env.SHARED_SERP_CACHE_PATH)
 *
 * 適用済みは schema_migrations(version) 行で判定（kw DBのみ。共有層は冪等CREATE）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { kwDb, voyageCacheDb, serpCacheDb, closeAll } from '../src/lib/db.js';
import { logger } from '../src/lib/logger.js';

const MIGRATIONS_DIR = resolve('db/migrations');

function applyKwMigrations() {
  const db = kwDb();
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (strftime(\'%s\',\'now\')))',
  );
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>).map(
      (r) => r.version,
    ),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    const version = f.split('_')[0]!;
    if (applied.has(`0.${parseInt(version, 10)}.0`) || applied.has(version)) {
      logger.info({ file: f }, 'kw migration already applied');
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8');
    logger.info({ file: f }, 'applying kw migration');
    db.exec(sql);
  }
}

function applySharedMigrations() {
  const voyageSql = readFileSync(join(MIGRATIONS_DIR, 'shared_voyage_0001.sql'), 'utf-8');
  voyageCacheDb().exec(voyageSql);
  logger.info('shared voyage cache schema ensured');

  const serpSql = readFileSync(join(MIGRATIONS_DIR, 'shared_serp_0001.sql'), 'utf-8');
  serpCacheDb().exec(serpSql);
  logger.info('shared serp cache schema ensured');
}

function main() {
  applyKwMigrations();
  applySharedMigrations();
  closeAll();
  logger.info('migrations done');
}

main();
