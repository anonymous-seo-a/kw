/**
 * [L3生存後] Ahrefs metrics 取得:
 *   active クラスタの全候補KWについて volume/KD/CPC を取得し l2_metrics に保存。
 *   バッチ100件ずつ overview endpoint を叩く。ahrefs_budget で予算ガード。
 *
 * 仕様§5「広げるのは無料、確定するのはAhrefs」。L3で生き残ったKWのみmetrics付与。
 */
import { kwDb } from '../lib/db.js';
import { ahrefsOverviewBatch } from '../lib/ahrefs.js';
import { BudgetExceededError } from '../lib/ahrefs-budget.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

const BATCH_SIZE = 100;

export interface L3MetricsResult {
  fetchedTotal: number;
  unitsUsed: number;
  missing: number;            // Ahrefsが返さなかったKW数
  batches: number;
  budgetExceeded: boolean;
}

export async function fetchL3Metrics(runId: string): Promise<L3MetricsResult> {
  const db = kwDb();
  // active クラスタの全メンバ
  const members = db
    .prepare(
      `SELECT DISTINCT m.candidate_id, lc.keyword
       FROM l3_cluster_members m
       JOIN l3_clusters c ON c.run_id=m.run_id AND c.cluster_id=m.cluster_id
       JOIN l1_candidates lc ON lc.id=m.candidate_id
       WHERE m.run_id=? AND c.status='active'`,
    )
    .all(runId) as Array<{ candidate_id: number; keyword: string }>;

  if (members.length === 0) {
    return { fetchedTotal: 0, unitsUsed: 0, missing: 0, batches: 0, budgetExceeded: false };
  }

  const ins = db.prepare(
    `INSERT INTO l2_metrics (candidate_id, volume, kd, cpc, intent, ahrefs_fetched_at)
     VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(candidate_id) DO UPDATE SET
       volume=excluded.volume, kd=excluded.kd, cpc=excluded.cpc,
       intent=excluded.intent, ahrefs_fetched_at=excluded.ahrefs_fetched_at`,
  );

  let fetched = 0;
  let unitsUsed = 0;
  let missing = 0;
  let batches = 0;
  let budgetExceeded = false;

  for (let i = 0; i < members.length; i += BATCH_SIZE) {
    const slice = members.slice(i, i + BATCH_SIZE);
    try {
      const r = await ahrefsOverviewBatch({
        keywords: slice.map((m) => m.keyword),
        runId,
      });
      batches++;
      unitsUsed += r.unitsActual;

      // 返却を keyword正規化で対応付け (Ahrefsは時に大文字小文字を正規化して返す)
      const byKw = new Map<string, (typeof r.rows)[number]>();
      for (const row of r.rows) {
        if (row.keyword) byKw.set(row.keyword.toLowerCase(), row);
      }

      db.transaction(() => {
        for (const m of slice) {
          const row = byKw.get(m.keyword.toLowerCase());
          if (!row) {
            // Ahrefs に存在しない → volume null
            ins.run(m.candidate_id, null, null, null, null);
            missing++;
            continue;
          }
          ins.run(
            m.candidate_id,
            row.volume ?? null,
            row.difficulty ?? null,
            row.cpc ?? null,
            Array.isArray(row.intents) ? row.intents.join(',') : null,
          );
          fetched++;
        }
      })();
      logger.info(
        { runId, batch: batches, size: slice.length, units: r.unitsActual },
        '[L3-metrics] batch',
      );
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        budgetExceeded = true;
        logger.error(
          { runId, requested: e.requested, available: e.available },
          '[L3-metrics] budget exceeded — stopping',
        );
        break;
      }
      logger.error({ runId, err: (e as Error).message }, '[L3-metrics] batch failed');
    }
  }

  audit({
    actor: 'system',
    eventType: 'l3.metrics.complete',
    entityType: 'run',
    entityId: runId,
    after: { fetchedTotal: fetched, unitsUsed, missing, batches, budgetExceeded },
  });

  logger.info(
    { runId, fetchedTotal: fetched, unitsUsed, missing, batches, budgetExceeded },
    '[L3-metrics] complete',
  );

  return { fetchedTotal: fetched, unitsUsed, missing, batches, budgetExceeded };
}
