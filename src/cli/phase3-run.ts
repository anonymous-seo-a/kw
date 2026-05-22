#!/usr/bin/env tsx
/**
 * CLI: Phase 3b [B]領域境界 + [INV]インベントリ
 *
 * 使い方:
 *   npm run phase3:run -- --run-id <L2_done or calibrate_done run_id>
 */
import { parseArgs } from 'node:util';
import { runBoundary } from '../boundary/run.js';
import { logger } from '../lib/logger.js';
import { closeAll } from '../lib/db.js';
import { setRunStatus } from '../lib/runs.js';

async function main() {
  const { values } = parseArgs({
    options: {
      'run-id': { type: 'string' },
    },
  });
  const runId = values['run-id'];
  if (!runId) {
    console.error('--run-id is required');
    process.exit(2);
  }

  try {
    const r = await runBoundary({ runId });
    console.log(JSON.stringify({ runId, ...r }, null, 2));
  } catch (e) {
    setRunStatus(runId, 'failed', (e as Error).message);
    logger.error({ err: (e as Error).stack }, '[B] run failed');
    process.exitCode = 1;
  } finally {
    closeAll();
  }
}

main();
