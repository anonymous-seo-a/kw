/**
 * 校正harness全実行 (4パラメータ) + calibration_reports へ保存。
 * Daikiゲート: ここでは "candidates + evidence + recommended" を出すだけ。
 * decided_value_json は Daiki が config 凍結時に setConfig() 経由で同期する。
 */
import { kwDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { buildSerpOverlapEvidence, suggestSerpOverlapCandidates } from './serp-overlap.js';
import { buildCosineEvidence, suggestCosineCandidates } from './cosine.js';
import { buildDensityGapEvidence, suggestDensityGapCandidates } from './density-gap.js';
import { buildSalienceCutoffEvidence, suggestSalienceCandidates } from './salience-cutoff.js';
import { setRunStatus } from '../lib/runs.js';

const PARAMETERS = [
  'serp_overlap_n',
  'cosine_threshold',
  'density_gap',
  'salience_cutoff',
] as const;

export interface CalibrationSummary {
  runId: string;
  parameter: (typeof PARAMETERS)[number];
  candidates: Array<{ value: number; rationale: string }>;
  recommended: { value: number; rationale: string };
}

function saveReport(input: {
  runId: string;
  parameter: string;
  evidence: unknown;
  candidates: Array<{ value: number; rationale: string }>;
  recommended: { value: number; rationale: string };
}): void {
  kwDb()
    .prepare(
      `INSERT INTO calibration_reports
         (run_id, parameter, evidence_json, candidates_json, recommended_value_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, parameter) DO UPDATE SET
         evidence_json=excluded.evidence_json,
         candidates_json=excluded.candidates_json,
         recommended_value_json=excluded.recommended_value_json,
         generated_at=strftime('%s','now')`,
    )
    .run(
      input.runId,
      input.parameter,
      JSON.stringify(input.evidence),
      JSON.stringify(input.candidates),
      JSON.stringify(input.recommended),
    );
  audit({
    actor: 'calibration',
    eventType: 'calibration.report',
    entityType: 'calibration_reports',
    entityId: `${input.runId}/${input.parameter}`,
    after: { candidates: input.candidates, recommended: input.recommended },
  });
}

function pickRecommended(
  candidates: Array<{ value: number; rationale: string }>,
): { value: number; rationale: string } {
  // 先頭を推奨1案として使う (harnessが順序付け済)
  return candidates[0] ?? { value: 0, rationale: 'no candidates produced' };
}

export async function runCalibration(opts: {
  runId: string;
  seedKw: string;
  serpOverlapPositiveMin?: number;
}): Promise<CalibrationSummary[]> {
  const { runId, seedKw } = opts;
  setRunStatus(runId, 'calibrate');
  audit({
    actor: 'system',
    eventType: 'calibration.start',
    entityType: 'run',
    entityId: runId,
  });

  // 1) SERP重複N
  const serp = buildSerpOverlapEvidence(runId);
  const serpCandidates = suggestSerpOverlapCandidates(serp.evidence);
  const serpRec = pickRecommended(serpCandidates);
  saveReport({
    runId,
    parameter: 'serp_overlap_n',
    evidence: serp.evidence,
    candidates: serpCandidates,
    recommended: serpRec,
  });
  logger.info({ runId, candidates: serpCandidates }, '[calibrate] serp_overlap_n');

  // 2) Cosine threshold (SERP重複を proxy positive にROC)
  const positiveMin = opts.serpOverlapPositiveMin ?? serpRec.value ?? 3;
  const cosEv = buildCosineEvidence(runId, serp.pairs, positiveMin);
  const cosCandidates = suggestCosineCandidates(cosEv);
  const cosRec = pickRecommended(cosCandidates);
  saveReport({
    runId,
    parameter: 'cosine_threshold',
    evidence: cosEv,
    candidates: cosCandidates,
    recommended: cosRec,
  });
  logger.info({ runId, auc: cosEv.auc, candidates: cosCandidates }, '[calibrate] cosine_threshold');

  // 3) Density gap
  const denEv = buildDensityGapEvidence(runId, seedKw);
  const denCandidates = suggestDensityGapCandidates(denEv);
  const denRec = pickRecommended(denCandidates);
  saveReport({
    runId,
    parameter: 'density_gap',
    evidence: denEv,
    candidates: denCandidates,
    recommended: denRec,
  });
  logger.info({ runId, valleys: denEv.valleys, candidates: denCandidates }, '[calibrate] density_gap');

  // 4) Salience cutoff
  const salEv = buildSalienceCutoffEvidence(runId);
  const salCandidates = suggestSalienceCandidates(salEv);
  const salRec = pickRecommended(salCandidates);
  saveReport({
    runId,
    parameter: 'salience_cutoff',
    evidence: salEv,
    candidates: salCandidates,
    recommended: salRec,
  });
  logger.info(
    { runId, totalEntities: salEv.totalEntities, candidates: salCandidates },
    '[calibrate] salience_cutoff',
  );

  setRunStatus(runId, 'calibrate_done');
  audit({
    actor: 'system',
    eventType: 'calibration.complete',
    entityType: 'run',
    entityId: runId,
    after: { parameters: PARAMETERS },
  });

  return [
    { runId, parameter: 'serp_overlap_n', candidates: serpCandidates, recommended: serpRec },
    { runId, parameter: 'cosine_threshold', candidates: cosCandidates, recommended: cosRec },
    { runId, parameter: 'density_gap', candidates: denCandidates, recommended: denRec },
    { runId, parameter: 'salience_cutoff', candidates: salCandidates, recommended: salRec },
  ];
}
