#!/usr/bin/env tsx
/**
 * CLI: kw [L2] enrichment runner.
 *
 * 使い方:
 *   npm run l2:run -- --run-id <L1 run_id>
 *   npm run l2:run -- --run-id <L1 run_id> --skip-nlp
 */
import { parseArgs } from 'node:util';
import { runL2 } from '../enrichment/l2-run.js';
import { logger } from '../lib/logger.js';
import { closeAll } from '../lib/db.js';
import { setRunStatus } from '../lib/runs.js';

async function main() {
  const { values } = parseArgs({
    options: {
      'run-id': { type: 'string' },
      'skip-embed': { type: 'boolean', default: false },
      'skip-nlp': { type: 'boolean', default: false },
      'skip-serp-fp': { type: 'boolean', default: false },
    },
  });
  const runId = values['run-id'];
  if (!runId) {
    console.error('--run-id is required (use the run_id from [L1])');
    process.exit(2);
  }

  try {
    const r = await runL2({
      runId,
      skip: {
        embed: values['skip-embed'],
        nlp: values['skip-nlp'],
        serpFp: values['skip-serp-fp'],
      },
    });
    console.log(JSON.stringify({ runId, ...r }, null, 2));
  } catch (e) {
    setRunStatus(runId, 'failed', (e as Error).message);
    logger.error({ err: (e as Error).stack }, '[L2] run failed');
    process.exitCode = 1;
  } finally {
    closeAll();
  }
}

main();
