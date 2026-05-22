#!/usr/bin/env tsx
/**
 * CLI: kw [L1] full pipeline runner.
 *
 * 使い方:
 *   npm run l1:run -- --seed "AGA おすすめ" --vertical medical
 *   npm run l1:run -- --seed "AGA おすすめ" --vertical medical --target both --scope full_silo
 */
import { parseArgs } from 'node:util';
import { createRun, setRunStatus } from '../lib/runs.js';
import { runL1 } from '../ingestion/l1-run.js';
import { logger } from '../lib/logger.js';
import { closeAll } from '../lib/db.js';

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: 'string' },
      target: { type: 'string', default: 'both' },
      scope: { type: 'string', default: 'full_silo' },
      'site-mode': { type: 'string', default: 'greenfield' },
      vertical: { type: 'string' },
      'skip-gsc': { type: 'boolean', default: false },
      'skip-fanout': { type: 'boolean', default: false },
      'skip-serp': { type: 'boolean', default: false },
      'skip-nlp': { type: 'boolean', default: false },
      'skip-ahrefs': { type: 'boolean', default: false },
      'ahrefs-limit': { type: 'string' },
    },
  });
  const seed = values.seed;
  if (!seed) {
    console.error('--seed is required');
    process.exit(2);
  }

  const runId = createRun({
    seedKw: seed,
    target: values.target as any,
    scope: values.scope as any,
    siteMode: values['site-mode'] as any,
    vertical: values.vertical ?? null,
  });
  logger.info({ runId, seed }, 'run created');

  try {
    const r = await runL1({
      runId,
      seedKw: seed,
      vertical: values.vertical ?? null,
      skip: {
        gsc: values['skip-gsc'],
        fanout: values['skip-fanout'],
        serp: values['skip-serp'],
        nlp: values['skip-nlp'],
        ahrefs: values['skip-ahrefs'],
      },
      ahrefsLimit: values['ahrefs-limit'] ? Number(values['ahrefs-limit']) : undefined,
    });
    console.log(JSON.stringify({ runId, ...r }, null, 2));
  } catch (e) {
    setRunStatus(runId, 'failed', (e as Error).message);
    logger.error({ err: (e as Error).stack }, 'run failed');
    process.exitCode = 1;
  } finally {
    closeAll();
  }
}

main();
