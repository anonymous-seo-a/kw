/**
 * [INV] エンティティ・インベントリ: 3信号の和集合 → recall最大列挙。
 * boundary_signals を集約して inventory_entities に書き込む (entity_key単位でdedupe)。
 */
import { kwDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export interface InventoryResult {
  totalUnique: number;
  bySignal: Record<string, number>;
  intersection: { all3: number; serpDensity: number; densityGraph: number; serpGraph: number };
  excluded: number;
}

export async function buildInventory(runId: string): Promise<InventoryResult> {
  const db = kwDb();
  const signals = db
    .prepare(
      `SELECT signal_kind, entity_key, entity_name, mid, score
       FROM boundary_signals WHERE run_id=?`,
    )
    .all(runId) as Array<{
    signal_kind: 'serp' | 'density' | 'graph';
    entity_key: string;
    entity_name: string;
    mid: string | null;
    score: number | null;
  }>;

  // entity_key で集約・寄与信号を記録
  type Agg = {
    entity_key: string;
    entity_name: string;
    mid: string | null;
    signals: Set<'serp' | 'density' | 'graph'>;
    maxScore: number;
  };
  const map = new Map<string, Agg>();
  for (const s of signals) {
    const cur = map.get(s.entity_key);
    if (!cur) {
      map.set(s.entity_key, {
        entity_key: s.entity_key,
        entity_name: s.entity_name,
        mid: s.mid,
        signals: new Set([s.signal_kind]),
        maxScore: s.score ?? 0,
      });
    } else {
      cur.signals.add(s.signal_kind);
      if ((s.score ?? 0) > cur.maxScore) cur.maxScore = s.score ?? 0;
      if (s.mid && !cur.mid) cur.mid = s.mid;
    }
  }

  // 過剰拡張ガード除外との突合
  const excludedKeys = new Set(
    (
      db
        .prepare(`SELECT entity_key FROM boundary_exclusions WHERE run_id=?`)
        .all(runId) as Array<{ entity_key: string }>
    ).map((r) => r.entity_key),
  );

  const bySignal: Record<string, number> = { serp: 0, density: 0, graph: 0 };
  const intersection = { all3: 0, serpDensity: 0, densityGraph: 0, serpGraph: 0 };
  let excluded = 0;

  const insert = db.prepare(
    `INSERT INTO inventory_entities (run_id, entity_key, entity_name, mid, signals_json, score)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, entity_key) DO UPDATE SET
       signals_json=excluded.signals_json,
       score=excluded.score`,
  );
  db.transaction(() => {
    db.prepare(`DELETE FROM inventory_entities WHERE run_id=?`).run(runId);
    for (const a of map.values()) {
      if (excludedKeys.has(a.entity_key)) {
        excluded++;
        continue;
      }
      const sigs = [...a.signals].sort();
      for (const k of sigs) bySignal[k]!++;
      const has = (k: string) => a.signals.has(k as any);
      if (has('serp') && has('density') && has('graph')) intersection.all3++;
      if (has('serp') && has('density')) intersection.serpDensity++;
      if (has('density') && has('graph')) intersection.densityGraph++;
      if (has('serp') && has('graph')) intersection.serpGraph++;
      insert.run(
        runId,
        a.entity_key,
        a.entity_name,
        a.mid,
        JSON.stringify(sigs),
        a.maxScore,
      );
    }
  })();

  const totalUnique = (
    db.prepare(`SELECT COUNT(*) AS n FROM inventory_entities WHERE run_id=?`).get(runId) as {
      n: number;
    }
  ).n;

  logger.info({ runId, totalUnique, bySignal, intersection, excluded }, '[INV] inventory built');
  return { totalUnique, bySignal, intersection, excluded };
}
