#!/usr/bin/env tsx
/**
 * CLI: Phase 5 [DIFF] + [L4]階層 + [L5]内部リンク + PageRank
 *
 *   npm run phase5:run -- --run-id <phase4_done run_id>
 */
import { parseArgs } from 'node:util';
import { kwDb, closeAll } from '../lib/db.js';
import { setRunStatus } from '../lib/runs.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { runDiff } from '../diff/run.js';
import { runIntentLayers } from '../hierarchy/intent-layers.js';
import { runL4Hierarchy } from '../hierarchy/l4.js';
import { runL5 } from '../links/l5.js';

async function main() {
  const { values } = parseArgs({
    options: {
      'run-id': { type: 'string' },
      'skip-intent-layers': { type: 'boolean', default: false },
    },
  });
  const runId = values['run-id'];
  if (!runId) {
    console.error('--run-id is required');
    process.exit(2);
  }

  try {
    setRunStatus(runId, 'phase5_running');
    audit({ actor: 'system', eventType: 'phase5.start', entityType: 'run', entityId: runId });

    const diff = await runDiff(runId);
    const intent = values['skip-intent-layers']
      ? { skipped: true as const, totalPages: 0, byLayer: { manifest: 0, latent: 0, reassurance: 0 }, llmCalls: 0 }
      : await runIntentLayers(runId);
    const l4 = await runL4Hierarchy(runId);
    const l5 = await runL5(runId);

    setRunStatus(runId, 'phase5_done');
    audit({
      actor: 'system',
      eventType: 'phase5.complete',
      entityType: 'run',
      entityId: runId,
      after: { diff, intent, l4, l5 },
    });

    console.log(JSON.stringify({ runId, diff, intent, l4, l5 }, null, 2));
  } catch (e) {
    setRunStatus(runId, 'failed', (e as Error).message);
    logger.error({ err: (e as Error).stack }, '[Phase5] run failed');
    process.exitCode = 1;
  } finally {
    closeAll();
  }
}

main();
