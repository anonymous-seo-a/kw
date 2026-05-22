#!/usr/bin/env tsx
/**
 * CLI: Phase 4 [L3] + [NEC] + コンプラフロア + [COV]
 *
 * 使い方:
 *   npm run phase4:run -- --run-id <b_done run_id>
 */
import { parseArgs } from 'node:util';
import { runPhase4 } from '../coverage/run.js';
import { logger } from '../lib/logger.js';
import { closeAll } from '../lib/db.js';
import { setRunStatus } from '../lib/runs.js';

async function main() {
  const { values } = parseArgs({
    options: {
      'run-id': { type: 'string' },
      'skip-axes': { type: 'boolean', default: false },
      'skip-normalize': { type: 'boolean', default: false },
    },
  });
  const runId = values['run-id'];
  if (!runId) {
    console.error('--run-id is required');
    process.exit(2);
  }

  try {
    const r = await runPhase4(runId, {
      skipAxes: values['skip-axes'],
      skipNormalize: values['skip-normalize'],
    });
    console.log(JSON.stringify({ runId, ...r }, null, 2));
  } catch (e) {
    setRunStatus(runId, 'failed', (e as Error).message);
    logger.error({ err: (e as Error).stack }, '[Phase4] run failed');
    process.exitCode = 1;
  } finally {
    closeAll();
  }
}

main();
