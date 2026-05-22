/**
 * Phase 4 統合: [AX] 軸事前分類 → [L3] → [NEC] → コンプラフロア → [COV]
 * Daikiゲート (コンプラ可否) は本コードが「フラグ提示」までで合否は出さない。
 */
import { kwDb } from '../lib/db.js';
import { setRunStatus } from '../lib/runs.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { runAxisClassification } from '../cluster/axes.js';
import { normalizeAxisValues } from '../cluster/axes-normalize.js';
import { runIntentFilters } from '../cluster/intent-filters.js';
import { runL3 } from '../cluster/l3.js';
// post-merge は現状 disable (狭く深く志向)。将来再有効化するなら src/cluster/post-merge.ts を import 復活。
// import { runPostL3Merge } from '../cluster/post-merge.js';
import { fetchL3Metrics } from '../enrichment/l3-metrics.js';
import { runNec } from '../necessity/nec.js';
import { applyComplianceFloor } from '../necessity/compliance-floor.js';
import { runCoverage } from './setcover.js';

export interface Phase4Result {
  axes: Awaited<ReturnType<typeof runAxisClassification>> | { skipped: true };
  axesNormalize: Awaited<ReturnType<typeof normalizeAxisValues>> | { skipped: true };
  intentFilters: Awaited<ReturnType<typeof runIntentFilters>>;
  l3: Awaited<ReturnType<typeof runL3>>;
  postMerge: { evaluatedPairs: number; merged: number; samples: unknown[] };
  l3Metrics: Awaited<ReturnType<typeof fetchL3Metrics>> | { skipped: true };
  nec: Awaited<ReturnType<typeof runNec>>;
  compliance: Awaited<ReturnType<typeof applyComplianceFloor>>;
  coverage: Awaited<ReturnType<typeof runCoverage>>;
}

export interface Phase4Options {
  /** Skip axis classification (use existing candidate_axes rows if any). Default false. */
  skipAxes?: boolean;
  /** Skip axis-value normalization. Default false. */
  skipNormalize?: boolean;
  /** Skip L3-metrics Ahrefs fetch. Default false. */
  skipMetrics?: boolean;
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
  const axesNormalize = opts.skipNormalize
    ? ({ skipped: true } as const)
    : await normalizeAxisValues(runId);
  const intentFilters = await runIntentFilters(runId);
  const l3 = await runL3(runId);
  const l3Metrics = opts.skipMetrics
    ? ({ skipped: true } as const)
    : await fetchL3Metrics(runId);
  const nec = await runNec(runId);
  // post-merge は無効化。アフィリエイトメディア「狭く深く」志向では bucket境界を厳守し、
  // 軸を跨ぐ自動 merge は意図混在を生むため不採用。
  // 汎用 format (クリニック/病院/医院/専門クリニック) は axes-normalize で core に降格済。
  const postMerge = { evaluatedPairs: 0, merged: 0, samples: [] };
  const compliance = await applyComplianceFloor(runId);
  const coverage = await runCoverage(runId);

  setRunStatus(runId, 'phase4_done');
  audit({
    actor: 'system',
    eventType: 'phase4.complete',
    entityType: 'run',
    entityId: runId,
    after: { axes, axesNormalize, intentFilters, l3, postMerge, l3Metrics, nec, compliance, coverage },
  });

  logger.info(
    { runId, axes, axesNormalize, intentFilters, l3, postMerge, l3Metrics, nec, compliance, coverage },
    '[Phase4] complete',
  );
  return { axes, axesNormalize, intentFilters, l3, postMerge, l3Metrics, nec, compliance, coverage };
}
