/**
 * [L2] 統合実行: embed → nlp → serp-fp。
 * Ahrefs本体コールは仕様§5に従い [L3] 生存後 (Phase 4) で発火。
 * ここでは ahrefs_budget の状態だけ確認して報告に含める。
 */
import { setRunStatus } from '../lib/runs.js';
import { logger } from '../lib/logger.js';
import { kwDb } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { budgetStatus } from '../lib/ahrefs-budget.js';
import { ingestL2Embeddings, type L2EmbedResult } from './l2-embed.js';
import { ingestL2Nlp, type L2NlpResult } from './l2-nlp.js';
import { ingestL2SerpFingerprints, type L2SerpFpResult } from './l2-serp-fp.js';

export interface L2RunOptions {
  runId: string;
  skip?: { embed?: boolean; nlp?: boolean; serpFp?: boolean };
}

export interface L2RunResult {
  candidateCount: number;
  embed: L2EmbedResult | { skipped: true };
  nlp: L2NlpResult | { skipped: true };
  serpFp: L2SerpFpResult | { skipped: true };
  budget: ReturnType<typeof budgetStatus>;
}

export async function runL2(opts: L2RunOptions): Promise<L2RunResult> {
  const { runId } = opts;
  const skip = opts.skip ?? {};

  const candidateCount = (
    kwDb().prepare('SELECT COUNT(*) AS n FROM l1_candidates WHERE run_id=?').get(runId) as {
      n: number;
    }
  ).n;
  if (candidateCount === 0) {
    throw new Error(`[L2] no L1 candidates for run_id=${runId}; run [L1] first`);
  }

  setRunStatus(runId, 'l2');
  audit({
    actor: 'system',
    eventType: 'l2.start',
    entityType: 'run',
    entityId: runId,
    after: { candidateCount, skip },
  });

  const embed = skip.embed ? ({ skipped: true } as const) : await ingestL2Embeddings(runId);
  const nlp = skip.nlp ? ({ skipped: true } as const) : await ingestL2Nlp(runId);
  const serpFp = skip.serpFp ? ({ skipped: true } as const) : await ingestL2SerpFingerprints(runId);
  const budget = budgetStatus();

  setRunStatus(runId, 'l2_done');
  audit({
    actor: 'system',
    eventType: 'l2.complete',
    entityType: 'run',
    entityId: runId,
    after: { embed, nlp, serpFp, budget },
  });

  logger.info({ runId, candidateCount, embed, nlp, serpFp, budget }, '[L2] complete');
  return { candidateCount, embed, nlp, serpFp, budget };
}
