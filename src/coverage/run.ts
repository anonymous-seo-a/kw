/**
 * Phase 4 統合: [L3] → [NEC] → コンプラフロア → [COV]
 * Daikiゲート (コンプラ可否) は本コードが「フラグ提示」までで合否は出さない。
 */
import { kwDb } from '../lib/db.js';
import { setRunStatus } from '../lib/runs.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { runL3 } from '../cluster/l3.js';
import { runNec } from '../necessity/nec.js';
import { applyComplianceFloor } from '../necessity/compliance-floor.js';
import { runCoverage } from './setcover.js';

export interface Phase4Result {
  l3: Awaited<ReturnType<typeof runL3>>;
  nec: Awaited<ReturnType<typeof runNec>>;
  compliance: Awaited<ReturnType<typeof applyComplianceFloor>>;
  coverage: Awaited<ReturnType<typeof runCoverage>>;
}

export async function runPhase4(runId: string): Promise<Phase4Result> {
  const row = kwDb()
    .prepare(`SELECT vertical, status FROM runs WHERE run_id=?`)
    .get(runId) as { vertical: string | null; status: string } | undefined;
  if (!row) throw new Error(`run not found: ${runId}`);

  setRunStatus(runId, 'phase4_running');
  audit({ actor: 'system', eventType: 'phase4.start', entityType: 'run', entityId: runId });

  const l3 = await runL3(runId);
  const nec = await runNec(runId);
  const compliance = await applyComplianceFloor(runId);
  const coverage = await runCoverage(runId);

  setRunStatus(runId, 'phase4_done');
  audit({
    actor: 'system',
    eventType: 'phase4.complete',
    entityType: 'run',
    entityId: runId,
    after: { l3, nec, compliance, coverage },
  });

  logger.info({ runId, l3, nec, compliance, coverage }, '[Phase4] complete');
  return { l3, nec, compliance, coverage };
}
