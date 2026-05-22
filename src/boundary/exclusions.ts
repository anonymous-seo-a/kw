/**
 * 過剰拡張ガード: 他seedの中心に近いエンティティを本サイロから除外する。
 *
 * 仕様§4: 「他centroidに近いエンティティは本サイロから除外し、当該サイロへ排出」
 *
 * 単一 seed のパイロットでは比較対象となる他seed centroid が存在しないため no-op。
 * 複数seed運用時 (Phase 9以降) に他seedのcentroidをロードして cosine距離比較で除外。
 * 現状は audit log に no-op 理由を残すだけ。
 */
import { kwDb } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';

export interface ExclusionResult {
  excluded: number;
  reason: string;
}

export async function applyOverExpansionGuard(runId: string): Promise<ExclusionResult> {
  // 他seedの数を数える
  const otherSeeds = kwDb()
    .prepare(`SELECT COUNT(DISTINCT seed_kw) AS n FROM runs WHERE run_id != ? AND status LIKE 'l2_done' OR status='calibrate_done'`)
    .get(runId) as { n: number };

  if (otherSeeds.n === 0) {
    const reason = 'single-seed pilot: no other seeds to compare against';
    audit({
      actor: 'system',
      eventType: 'b.exclusion.skip',
      entityType: 'run',
      entityId: runId,
      note: reason,
    });
    logger.info({ runId }, `[B] over-expansion guard skipped: ${reason}`);
    return { excluded: 0, reason };
  }

  // TODO: 複数seed運用時の実装
  // - 他run_idのboundary_signals/inventory_entitiesから他centroidを取得
  // - 本run の各 entity vector を他centroidとも比較し、より近い側があれば除外
  const reason = 'multi-seed exclusion not yet implemented (Phase 9 TODO)';
  audit({
    actor: 'system',
    eventType: 'b.exclusion.todo',
    entityType: 'run',
    entityId: runId,
    note: reason,
  });
  logger.warn({ runId, otherSeeds: otherSeeds.n }, `[B] over-expansion guard TODO: ${reason}`);
  return { excluded: 0, reason };
}
