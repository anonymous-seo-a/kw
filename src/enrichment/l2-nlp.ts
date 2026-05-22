/**
 * [L2] 全L1候補に Google NLP entity salience + MID を付与する。
 * GOOGLE_APPLICATION_CREDENTIALS 未設定なら graceful skip + audit。
 */
import { kwDb } from '../lib/db.js';
import { analyzeEntities } from '../lib/google-nlp.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

export interface L2NlpResult {
  processed: number;
  entitiesTotal: number;
  failed: number;
  skipped: boolean;
  skipReason?: string;
}

export async function ingestL2Nlp(runId: string): Promise<L2NlpResult> {
  if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
    const reason = 'GOOGLE_APPLICATION_CREDENTIALS unset';
    audit({
      actor: 'system',
      eventType: 'l2.nlp.skip',
      entityType: 'run',
      entityId: runId,
      note: reason,
    });
    logger.warn({ runId }, `[L2] nlp skipped: ${reason}`);
    return { processed: 0, entitiesTotal: 0, failed: 0, skipped: true, skipReason: reason };
  }

  const db = kwDb();
  const candidates = db
    .prepare('SELECT id, keyword FROM l1_candidates WHERE run_id=? ORDER BY id')
    .all(runId) as Array<{ id: number; keyword: string }>;

  const insert = db.prepare(
    `INSERT INTO l2_entities (candidate_id, name, type, mid, wikipedia_url, salience, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const clear = db.prepare('DELETE FROM l2_entities WHERE candidate_id=?');

  let processed = 0;
  let entitiesTotal = 0;
  let failed = 0;

  for (const c of candidates) {
    try {
      const ents = await analyzeEntities(c.keyword);
      db.transaction(() => {
        clear.run(c.id);
        for (const e of ents) {
          insert.run(
            c.id,
            e.name,
            e.type,
            e.mid ?? null,
            e.wikipediaUrl ?? null,
            e.salience,
            Object.keys(e.meta).length > 0 ? JSON.stringify(e.meta) : null,
          );
          entitiesTotal++;
        }
      })();
      processed++;
    } catch (e) {
      failed++;
      logger.error({ candidateId: c.id, err: (e as Error).message }, '[L2] nlp failed');
    }
  }

  logger.info({ runId, processed, entitiesTotal, failed }, '[L2] nlp done');
  return { processed, entitiesTotal, failed, skipped: false };
}
