/**
 * Phase 3b 統合実行: density → serp → graph → exclusions → inventory。
 * 全しきい値は config table から取得 (Daiki確定値)。
 */
import { kwDb } from '../lib/db.js';
import { setRunStatus } from '../lib/runs.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { thresholds } from './thresholds.js';
import { buildDensitySignal } from './signals/density.js';
import { buildSerpSignal } from './signals/serp.js';
import { buildGraphSignal } from './signals/graph.js';
import { applyOverExpansionGuard } from './exclusions.js';
import { buildInventory } from './inventory.js';

export interface BoundaryRunResult {
  thresholds: ReturnType<typeof thresholds>;
  density: Awaited<ReturnType<typeof buildDensitySignal>>;
  serp: Awaited<ReturnType<typeof buildSerpSignal>>;
  graph: Awaited<ReturnType<typeof buildGraphSignal>>;
  exclusions: Awaited<ReturnType<typeof applyOverExpansionGuard>>;
  inventory: Awaited<ReturnType<typeof buildInventory>>;
}

export async function runBoundary(opts: { runId: string }): Promise<BoundaryRunResult> {
  const { runId } = opts;
  const row = kwDb()
    .prepare(`SELECT seed_kw, status FROM runs WHERE run_id=?`)
    .get(runId) as { seed_kw: string; status: string } | undefined;
  if (!row) throw new Error(`run not found: ${runId}`);

  const th = thresholds();
  setRunStatus(runId, 'b_running');
  audit({
    actor: 'system',
    eventType: 'b.start',
    entityType: 'run',
    entityId: runId,
    after: { thresholds: th },
  });

  const density = await buildDensitySignal(runId, row.seed_kw);
  const serp = await buildSerpSignal(runId);
  const graph = await buildGraphSignal(runId);
  const exclusions = await applyOverExpansionGuard(runId);
  const inventory = await buildInventory(runId);

  setRunStatus(runId, 'b_done');
  audit({
    actor: 'system',
    eventType: 'b.complete',
    entityType: 'run',
    entityId: runId,
    after: { density, serp, graph, exclusions, inventory },
  });

  logger.info({ runId, thresholds: th, density, serp, graph, exclusions, inventory }, '[B] complete');
  return { thresholds: th, density, serp, graph, exclusions, inventory };
}
