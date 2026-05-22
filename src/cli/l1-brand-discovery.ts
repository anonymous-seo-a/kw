#!/usr/bin/env tsx
/**
 * CLI: brand-discovery を既存 run_id に対して単独実行 (incremental L1 expansion)。
 *   npm run l1:brand-discovery -- --run-id <existing run_id>
 */
import { parseArgs } from 'node:util';
import { kwDb, closeAll } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { ingestBrandDiscovery } from '../ingestion/l1-brand-discovery.js';

async function main() {
  const { values } = parseArgs({
    options: {
      'run-id': { type: 'string' },
      'brand-max': { type: 'string' },
      'brand-per-limit': { type: 'string' },
    },
  });
  const runId = values['run-id'];
  if (!runId) {
    console.error('--run-id is required');
    process.exit(2);
  }
  const row = kwDb()
    .prepare('SELECT seed_kw, vertical FROM runs WHERE run_id=?')
    .get(runId) as { seed_kw: string; vertical: string | null } | undefined;
  if (!row) {
    console.error(`run not found: ${runId}`);
    process.exit(2);
  }

  try {
    const r = await ingestBrandDiscovery(runId, {
      seedKw: row.seed_kw,
      vertical: row.vertical,
      maxBrands: values['brand-max'] ? Number(values['brand-max']) : undefined,
      perBrandLimit: values['brand-per-limit'] ? Number(values['brand-per-limit']) : undefined,
    });
    console.log(JSON.stringify({ runId, ...r }, null, 2));
  } catch (e) {
    logger.error({ err: (e as Error).stack }, '[brand-discovery] failed');
    process.exitCode = 1;
  } finally {
    closeAll();
  }
}

main();
