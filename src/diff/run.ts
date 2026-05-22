/**
 * [DIFF] greenfield/existing 突合.
 *   v1 = greenfield: 全 page を status='new' (=不足) として記録。
 *   existing は将来用 I/F のみ (cannibalization-system連携、本sessionでは未実装)。
 */
import { kwDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

export interface DiffResult {
  mode: 'greenfield' | 'existing';
  totalPages: number;
  newPages: number;
}

export async function runDiff(runId: string): Promise<DiffResult> {
  const db = kwDb();
  const runRow = db
    .prepare(`SELECT site_mode FROM runs WHERE run_id=?`)
    .get(runId) as { site_mode: 'greenfield' | 'existing' } | undefined;
  if (!runRow) throw new Error(`run not found: ${runId}`);

  const pages = db
    .prepare(`SELECT page_id FROM cov_pages WHERE run_id=?`)
    .all(runId) as Array<{ page_id: string }>;

  db.transaction(() => {
    db.prepare(`DELETE FROM diff_pages WHERE run_id=?`).run(runId);
    const ins = db.prepare(
      `INSERT INTO diff_pages (run_id, page_id, mode, status, rationale) VALUES (?, ?, ?, ?, ?)`,
    );
    if (runRow.site_mode === 'greenfield') {
      for (const p of pages) {
        ins.run(runId, p.page_id, 'greenfield', 'new', 'greenfield: silo新規・全page不足扱い');
      }
    } else {
      // TODO: existingモード: cannibalization-systemに既存URL一覧を渡して突合
      for (const p of pages) {
        ins.run(
          runId,
          p.page_id,
          'existing',
          'new',
          'TODO: cannibalization-system連携で既存URL突合 (v1未実装)',
        );
      }
    }
  })();

  audit({
    actor: 'system',
    eventType: 'diff.complete',
    entityType: 'run',
    entityId: runId,
    after: { mode: runRow.site_mode, totalPages: pages.length },
  });

  logger.info({ runId, mode: runRow.site_mode, totalPages: pages.length }, '[DIFF] done');
  return {
    mode: runRow.site_mode,
    totalPages: pages.length,
    newPages: pages.length, // greenfield固定
  };
}
