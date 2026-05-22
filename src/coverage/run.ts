/**
 * Phase 4 統合: [AX] 軸事前分類 → [L3] → [NEC] → コンプラフロア → [COV]
 * Daikiゲート (コンプラ可否) は本コードが「フラグ提示」までで合否は出さない。
 */
import { kwDb } from '../lib/db.js';
import { setRunStatus } from '../lib/runs.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { runAxisClassification } from '../cluster/axes.js';
import { runL3 } from '../cluster/l3.js';
import { runNec } from '../necessity/nec.js';
import { applyComplianceFloor } from '../necessity/compliance-floor.js';
import { runCoverage } from './setcover.js';

export interface Phase4Result {
  axes: Awaited<ReturnType<typeof runAxisClassification>> | { skipped: true };
  l3: Awaited<ReturnType<typeof runL3>>;
  nec: Awaited<ReturnType<typeof runNec>>;
  compliance: Awaited<ReturnType<typeof applyComplianceFloor>>;
  coverage: Awaited<ReturnType<typeof runCoverage>>;
}

export interface Phase4Options {
  /** Skip axis classification (use existing candidate_axes rows if any). Default false. */
  skipAxes?: boolean;
}

export async function runPhase4(runId: string, opts: Phase4Options = {}): Promise<Phase4Result> {
  const row = kwDb()
    .prepare(`SELECT vertical, status FROM runs WHERE run_id=?`)
    .get(runId) as { vertical: string | null; status: string } | undefined;
  if (!row) throw new Error(`run not found: ${runId}`);

  setRunStatus(runId, 'phase4_running');
  audit({ actor: 'system', eventType: 'phase4.start', entityType: 'run', entityId: runId });

  const axes = opts.skipAxes
    ? ({ skipped: true } as const)
    : await runAxisClassification(runId);
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
    after: { axes, l3, nec, compliance, coverage },
  });

  logger.info({ runId, axes, l3, nec, compliance, coverage }, '[Phase4] complete');
  return { axes, l3, nec, compliance, coverage };
}
