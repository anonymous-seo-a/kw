/**
 * [NEC] 必然性フィルタ:
 *   各クラスタが「順位/引用を生むか」を判定し page / passage_absorbed を決める。
 *
 * 判定ルール (priority順):
 *   1. cluster size = 1 (singleton) → 最も近いcluster (size>=2) に absorb
 *   2. cluster 累積volume < config 'nec_volume_min_cluster_sum' (default 30) → 同様 absorb
 *      (rep volume が null かつ累積も小さい場合の救済もしない = absorbe)
 *   3. それ以外 → page
 *
 * volume は l2_metrics から取得 (Phase 4 の [L3生存後] Ahrefs metricsで投入済)。
 */
import { kwDb } from '../lib/db.js';
import { cosine } from '../lib/voyage.js';
import { loadRunVectors } from '../lib/embeddings.js';
import { getConfigOr } from '../lib/config.js';
import { logger } from '../lib/logger.js';

export interface NecResult {
  totalClusters: number;
  pages: number;
  absorbed: number;
  absorbedByVolume: number;
  absorbedBySingleton: number;
  absorbedByBrand: number;
  volumeMinClusterSum: number;
  clustersWithoutVolume: number;
}

export async function runNec(runId: string): Promise<NecResult> {
  const volumeMin = getConfigOr<number>('nec_volume_min_cluster_sum', 30);

  const db = kwDb();
  const clusters = db
    .prepare(
      `SELECT cluster_id, size, json_extract(metric_json,'$.bucket') AS bucket
       FROM l3_clusters WHERE run_id=? AND status='active'`,
    )
    .all(runId) as Array<{ cluster_id: string; size: number; bucket: string | null }>;
  if (clusters.length === 0) {
    return {
      totalClusters: 0,
      pages: 0,
      absorbed: 0,
      absorbedByVolume: 0,
      absorbedBySingleton: 0,
      absorbedByBrand: 0,
      volumeMinClusterSum: volumeMin,
      clustersWithoutVolume: 0,
    };
  }

  const vectors = loadRunVectors(runId);
  const vecByCandidate = new Map(vectors.map((v) => [v.candidateId, v.vector] as const));

  // 累積 volume をクラスタごとに集計
  const volumeStmt = db.prepare(
    `SELECT COALESCE(SUM(metrics.volume), 0) AS sum_vol,
            COUNT(metrics.volume) AS volume_rows
     FROM l3_cluster_members m
     LEFT JOIN l2_metrics metrics ON metrics.candidate_id = m.candidate_id
     WHERE m.run_id=? AND m.cluster_id=?`,
  );

  type ClusterInfo = {
    id: string;
    size: number;
    repVec: Float32Array | null;
    sumVolume: number;
    volumeRows: number;
    isBrand: boolean;
  };
  const info: ClusterInfo[] = clusters.map((c) => {
    const rep = db
      .prepare(
        `SELECT candidate_id FROM l3_cluster_members
         WHERE run_id=? AND cluster_id=? AND is_representative=1 LIMIT 1`,
      )
      .get(runId, c.cluster_id) as { candidate_id: number } | undefined;
    const vec = rep ? vecByCandidate.get(rep.candidate_id) ?? null : null;
    const vRow = volumeStmt.get(runId, c.cluster_id) as { sum_vol: number; volume_rows: number };
    return {
      id: c.cluster_id,
      size: c.size,
      repVec: vec,
      sumVolume: vRow.sum_vol ?? 0,
      volumeRows: vRow.volume_rows ?? 0,
      isBrand: (c.bucket ?? '').startsWith('brand:'),
    };
  });

  const ins = db.prepare(
    `INSERT INTO nec_decisions (run_id, cluster_id, decision, reason, absorbed_into)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id, cluster_id) DO UPDATE SET
       decision=excluded.decision, reason=excluded.reason,
       absorbed_into=excluded.absorbed_into, decided_at=strftime('%s','now')`,
  );
  const updateCluster = db.prepare(
    `UPDATE l3_clusters SET status=?, absorbed_into=? WHERE run_id=? AND cluster_id=?`,
  );

  // 吸収先候補 = size >= 2 かつ sumVolume >= volumeMin の "強い" クラスタ
  const strongClusters = info.filter((c) => c.size >= 2 && c.sumVolume >= volumeMin && c.repVec);

  let pages = 0;
  let absorbed = 0;
  let absorbedByVolume = 0;
  let absorbedBySingleton = 0;
  let absorbedByBrand = 0;
  let clustersWithoutVolume = 0;

  db.transaction(() => {
    db.prepare(`DELETE FROM nec_decisions WHERE run_id=?`).run(runId);
    // 全クラスタの status を一旦 active にリセット (再判定のため)
    db.prepare(
      `UPDATE l3_clusters SET status='active', absorbed_into=NULL WHERE run_id=?`,
    ).run(runId);

    for (const c of info) {
      if (c.volumeRows === 0) clustersWithoutVolume++;

      // ルール0: brand bucket → 自動 passage_absorbed
      // 競合ブランド名ページは自社silo内には作らない (出し切りはinventory側で担保)
      if (c.isBrand) {
        const target = c.repVec ? pickNearestStrong(c, strongClusters) : null;
        if (target) {
          ins.run(
            runId,
            c.id,
            'passage_absorbed',
            `brand bucket auto-absorbed into ${target.id} (cosine=${target.sim.toFixed(3)})`,
            target.id,
          );
          updateCluster.run('absorbed', target.id, runId, c.id);
          absorbed++;
          absorbedByBrand++;
        } else {
          // 吸収先なし → 例外的にpage化 (孤立brand)
          ins.run(
            runId,
            c.id,
            'page',
            `brand bucket but no absorption target (orphan)`,
            null,
          );
          pages++;
        }
        continue;
      }

      // ルール1: singleton
      if (c.size < 2) {
        if (!c.repVec) {
          ins.run(runId, c.id, 'page', 'singleton kept (no vector)', null);
          pages++;
          continue;
        }
        const target = pickNearestStrong(c, strongClusters);
        if (!target) {
          ins.run(runId, c.id, 'page', 'singleton kept (no absorption target)', null);
          pages++;
          continue;
        }
        ins.run(
          runId,
          c.id,
          'passage_absorbed',
          `singleton absorbed into ${target.id} (cosine=${target.sim.toFixed(3)})`,
          target.id,
        );
        updateCluster.run('absorbed', target.id, runId, c.id);
        absorbed++;
        absorbedBySingleton++;
        continue;
      }

      // ルール2: volume floor
      if (c.sumVolume < volumeMin) {
        if (!c.repVec) {
          ins.run(
            runId,
            c.id,
            'page',
            `low volume kept (sum=${c.sumVolume}, no vector for absorption)`,
            null,
          );
          pages++;
          continue;
        }
        const target = pickNearestStrong(c, strongClusters);
        if (!target) {
          ins.run(
            runId,
            c.id,
            'page',
            `low volume kept (sum=${c.sumVolume}, no absorption target)`,
            null,
          );
          pages++;
          continue;
        }
        ins.run(
          runId,
          c.id,
          'passage_absorbed',
          `low volume (sum=${c.sumVolume} < ${volumeMin}) absorbed into ${target.id} (cosine=${target.sim.toFixed(3)})`,
          target.id,
        );
        updateCluster.run('absorbed', target.id, runId, c.id);
        absorbed++;
        absorbedByVolume++;
        continue;
      }

      // ルール3: page
      ins.run(
        runId,
        c.id,
        'page',
        `cluster size=${c.size}, sumVolume=${c.sumVolume}`,
        null,
      );
      pages++;
    }
  })();

  logger.info(
    {
      runId,
      totalClusters: info.length,
      pages,
      absorbed,
      absorbedBySingleton,
      absorbedByVolume,
      absorbedByBrand,
      volumeMin,
      clustersWithoutVolume,
    },
    '[NEC] done',
  );

  return {
    totalClusters: info.length,
    pages,
    absorbed,
    absorbedByVolume,
    absorbedBySingleton,
    absorbedByBrand,
    volumeMinClusterSum: volumeMin,
    clustersWithoutVolume,
  };
}

function pickNearestStrong(
  c: { id: string; repVec: Float32Array | null },
  strong: Array<{ id: string; repVec: Float32Array | null }>,
): { id: string; sim: number } | null {
  if (!c.repVec) return null;
  let bestId: string | null = null;
  let bestSim = -1;
  for (const s of strong) {
    if (s.id === c.id || !s.repVec) continue;
    const sim = cosine(c.repVec, s.repVec);
    if (sim > bestSim) {
      bestSim = sim;
      bestId = s.id;
    }
  }
  return bestId ? { id: bestId, sim: bestSim } : null;
}
