/**
 * グラフ信号: seedエンティティから Knowledge Graph を salience 減衰でNホップ。
 *
 * パイロット実装: KG API は未実装 (Phase 3b の枠を超える)。
 * 代わりに既存の l1_entities + l2_entities を seed エンティティ集合と見なし、
 * salience ≥ salience_cutoff のものを graph signal として記録する。
 *
 * 真の KG ホップ展開 (Google KG Search API) は TODO (Phase 4 or 9)。
 * NLP creds 未配置だと l1_entities/l2_entities は空のため、この信号は no-op になる。
 */
import { kwDb } from '../../lib/db.js';
import { thresholds } from '../thresholds.js';
import { logger } from '../../lib/logger.js';
import { normalizeKeyword } from '../../lib/normalize.js';
import { audit } from '../../lib/audit.js';

export interface GraphSignalResult {
  salienceCutoff: number;
  l1Entities: number;
  l2Entities: number;
  added: number;
  skipped: boolean;
  skipReason?: string;
}

export async function buildGraphSignal(runId: string): Promise<GraphSignalResult> {
  const cutoff = thresholds().salienceCutoff;

  const fromL1 = kwDb()
    .prepare(
      `SELECT name, mid, type, salience, wikipedia_url
       FROM l1_entities WHERE run_id=? AND salience IS NOT NULL`,
    )
    .all(runId) as Array<{
    name: string;
    mid: string | null;
    type: string | null;
    salience: number;
    wikipedia_url: string | null;
  }>;
  const fromL2 = kwDb()
    .prepare(
      `SELECT le.name, le.mid, le.type, le.salience, le.wikipedia_url
       FROM l2_entities le
       JOIN l1_candidates lc ON lc.id = le.candidate_id
       WHERE lc.run_id=?`,
    )
    .all(runId) as Array<{
    name: string;
    mid: string | null;
    type: string | null;
    salience: number;
    wikipedia_url: string | null;
  }>;

  if (fromL1.length === 0 && fromL2.length === 0) {
    const reason = 'no entities (NLP skipped) → graph signal no-op';
    audit({
      actor: 'system',
      eventType: 'b.graph.skip',
      entityType: 'run',
      entityId: runId,
      note: reason,
    });
    logger.warn({ runId, cutoff }, `[B] graph signal skipped: ${reason}`);
    return {
      salienceCutoff: cutoff,
      l1Entities: 0,
      l2Entities: 0,
      added: 0,
      skipped: true,
      skipReason: reason,
    };
  }

  // dedupe by (mid|name), keep max salience
  type Row = (typeof fromL1)[number];
  const merged = new Map<string, Row>();
  for (const r of [...fromL1, ...fromL2]) {
    const key = r.mid ? `mid:${r.mid}` : `name:${normalizeKeyword(r.name)}`;
    const existing = merged.get(key);
    if (!existing || (r.salience ?? 0) > (existing.salience ?? 0)) merged.set(key, r);
  }

  const db = kwDb();
  const insert = db.prepare(
    `INSERT INTO boundary_signals (run_id, signal_kind, entity_key, entity_name, mid, score, source_meta_json)
     VALUES (?, 'graph', ?, ?, ?, ?, ?)`,
  );

  let added = 0;
  db.transaction(() => {
    db.prepare(`DELETE FROM boundary_signals WHERE run_id=? AND signal_kind='graph'`).run(runId);
    for (const [key, r] of merged) {
      if ((r.salience ?? 0) < cutoff) continue;
      insert.run(
        runId,
        key,
        r.name,
        r.mid,
        r.salience,
        JSON.stringify({
          type: r.type,
          wikipediaUrl: r.wikipedia_url,
          hop: 0, // 真のKG hopは未実装
        }),
      );
      added++;
    }
  })();

  logger.info(
    { runId, cutoff, l1: fromL1.length, l2: fromL2.length, added },
    '[B] graph signal',
  );
  return {
    salienceCutoff: cutoff,
    l1Entities: fromL1.length,
    l2Entities: fromL2.length,
    added,
    skipped: false,
  };
}
