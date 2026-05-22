#!/usr/bin/env tsx
/**
 * CLI: Phase 6 [L6]真=美ゲート + 4成果物 export
 *
 *   npm run phase6:run -- --run-id <phase5_done run_id>
 */
import { parseArgs } from 'node:util';
import { kwDb, closeAll } from '../lib/db.js';
import { setRunStatus } from '../lib/runs.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { runTrueBeauty } from '../truebeauty/checks.js';
import { exportAllArtifacts } from '../export/artifacts.js';

async function main() {
  const { values } = parseArgs({
    options: { 'run-id': { type: 'string' } },
  });
  const runId = values['run-id'];
  if (!runId) {
    console.error('--run-id is required');
    process.exit(2);
  }

  try {
    setRunStatus(runId, 'phase6_running');
    audit({ actor: 'system', eventType: 'phase6.start', entityType: 'run', entityId: runId });

    const checks = await runTrueBeauty(runId);
    const exports = exportAllArtifacts(runId);

    setRunStatus(runId, 'phase6_done');
    audit({
      actor: 'system',
      eventType: 'phase6.complete',
      entityType: 'run',
      entityId: runId,
      after: { overallStatus: checks.overallStatus, summary: checks.checks.map((c) => ({ kind: c.kind, status: c.status })) },
    });

    console.log(JSON.stringify({ runId, checks, exports }, null, 2));
  } catch (e) {
    setRunStatus(runId, 'failed', (e as Error).message);
    logger.error({ err: (e as Error).stack }, '[Phase6] failed');
    process.exitCode = 1;
  } finally {
    closeAll();
  }
}

main();
