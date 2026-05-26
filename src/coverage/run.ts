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
import { runLocationHierarchy } from '../cluster/location-hierarchy.js';
import { runLocationNormalize } from '../cluster/location-normalize.js';
import { runL3 } from '../cluster/l3.js';
import { fetchL3Metrics } from '../enrichment/l3-metrics.js';
import { runNec } from '../necessity/nec.js';
import { runPageMergeSerp } from '../cluster/page-merge-serp.js';
import { runNoiseFilter } from '../cluster/noise-filter.js';
import { runThemeDerive } from '../cluster/theme-derive.js';
import { runRegionRollup } from '../cluster/region-rollup.js';
import { runTaxonomyMap } from '../cluster/taxonomy-map.js';
import { applyComplianceFloor } from '../necessity/compliance-floor.js';
import { runCoverage } from './setcover.js';

export interface Phase4Result {
  axes: Awaited<ReturnType<typeof runAxisClassification>> | { skipped: true };
  axesNormalize: Awaited<ReturnType<typeof normalizeAxisValues>> | { skipped: true };
  locationNormalize: Awaited<ReturnType<typeof runLocationNormalize>> | { skipped: true };
  intentFilters: Awaited<ReturnType<typeof runIntentFilters>>;
  locationHierarchy: Awaited<ReturnType<typeof runLocationHierarchy>> | { skipped: true };
  l3: Awaited<ReturnType<typeof runL3>>;
  l3Metrics: Awaited<ReturnType<typeof fetchL3Metrics>> | { skipped: true };
  nec: Awaited<ReturnType<typeof runNec>>;
  compliance: Awaited<ReturnType<typeof applyComplianceFloor>>;
  coverage: Awaited<ReturnType<typeof runCoverage>>;
  pageMergeSerp: Awaited<ReturnType<typeof runPageMergeSerp>>;
  noiseFilter: Awaited<ReturnType<typeof runNoiseFilter>>;
  regionRollup: Awaited<ReturnType<typeof runRegionRollup>>;
  coverage2: Awaited<ReturnType<typeof runCoverage>>;
  taxonomyMap: Awaited<ReturnType<typeof runTaxonomyMap>>;
  themeDerive: Awaited<ReturnType<typeof runThemeDerive>> | { skipped: true };
}

export interface Phase4Options {
  /** Skip axis classification (use existing candidate_axes rows if any). Default false. */
  skipAxes?: boolean;
  /** Skip axis-value normalization. Default false. */
  skipNormalize?: boolean;
  /** Skip L3-metrics Ahrefs fetch. Default false. */
  skipMetrics?: boolean;
  /** Skip Claude-driven location hierarchy classification. Default false. */
  skipLocationHierarchy?: boolean;
  /** Skip location 表記ゆれ正規化 (spec-01 修正C-1). Default false. */
  skipLocationNormalize?: boolean;
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
  // 修正C-1 (spec-01): location 表記ゆれ正規化 (axes-normalize後・filter前)
  const locationNormalize = opts.skipLocationNormalize
    ? ({ skipped: true } as const)
    : await runLocationNormalize(runId);
  const intentFilters = await runIntentFilters(runId);
  const locationHierarchy = opts.skipLocationHierarchy
    ? ({ skipped: true } as const)
    : await runLocationHierarchy(runId);
  const l3 = await runL3(runId);
  const l3Metrics = opts.skipMetrics
    ? ({ skipped: true } as const)
    : await fetchL3Metrics(runId);
  const nec = await runNec(runId);
  const compliance = await applyComplianceFloor(runId);
  // 1st pass coverage (NEC直後・page列挙が必要なため)
  const coverage = await runCoverage(runId);

  // 修正B (spec-01): cross-bucket SERP page merge (N=3 by default config)
  const pageMergeSerp = await runPageMergeSerp(runId);
  // 修正C-2 (spec-01): noise location pages を nec_decisions='noise_excluded' に
  const noiseFilter = await runNoiseFilter(runId);
  // spec-02 修正C: 地域 sub薄い都市 → 親 roll-up
  const regionRollup = await runRegionRollup(runId);
  // 2nd pass coverage (merge + noise filter + region rollup 後の最終 cov_pages)
  const coverage2 = await runCoverage(runId);
  // spec-02 修正B: top-down 12軸 taxonomy 割当 (旧 k-means theme-derive 置換)
  const taxonomyMap = await runTaxonomyMap(runId);
  // 旧 theme-derive (k-means + Claude命名) は spec-02で taxonomyMap に置換。skip。
  const themeDerive = { skipped: true } as const;

  setRunStatus(runId, 'phase4_done');
  audit({
    actor: 'system',
    eventType: 'phase4.complete',
    entityType: 'run',
    entityId: runId,
    after: {
      axes, axesNormalize, locationNormalize, intentFilters, locationHierarchy, l3,
      l3Metrics, nec, compliance, coverage,
      pageMergeSerp, noiseFilter, regionRollup, coverage2, taxonomyMap, themeDerive,
    },
  });

  logger.info(
    {
      runId, axes, axesNormalize, locationNormalize, intentFilters, locationHierarchy, l3,
      l3Metrics, nec, compliance, coverage,
      pageMergeSerp, noiseFilter, regionRollup, coverage2, taxonomyMap, themeDerive,
    },
    '[Phase4] complete',
  );
  return {
    axes, axesNormalize, locationNormalize, intentFilters, locationHierarchy, l3,
    l3Metrics, nec, compliance, coverage,
    pageMergeSerp, noiseFilter, regionRollup, coverage2, taxonomyMap, themeDerive,
  };
}
