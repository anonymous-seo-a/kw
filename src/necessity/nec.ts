/**
 * [NEC] 必然性フィルタ:
 *   各クラスタが「順位/引用を生むか」を判定し page/passage_absorbed を決める。
 *
 * 真の判定はAhrefs metrics (Phase 4 [L3]生存後の Ahrefs Keywords Explorer 結果) + 内部参照頻度
 * を要するが、パイロット段階では:
 *   - 単独クラスタ (size=1) で SERP fingerprint が弱い → 'passage_absorbed' に他クラスタへ吸収
 *   - size≥2 → 'page'
 *
 * 完全実装 (Ahrefs metrics ベース) は Phase 9 で再実装。
 */
import { kwDb } from '../lib/db.js';
import { cosine } from '../lib/voyage.js';
import { loadRunVectors } from '../lib/embeddings.js';
import { logger } from '../lib/logger.js';

export interface NecResult {
  totalClusters: number;
  pages: number;
  absorbed: number;
}

export async function runNec(runId: string): Promise<NecResult> {
  const db = kwDb();
  const clusters = db
    .prepare(`SELECT cluster_id, size FROM l3_clusters WHERE run_id=? AND status='active'`)
    .all(runId) as Array<{ cluster_id: string; size: number }>;
  if (clusters.length === 0) return { totalClusters: 0, pages: 0, absorbed: 0 };

  // クラスタ代表ベクトル (kw 経由)
  const vectors = loadRunVectors(runId);
  const vecByCandidate = new Map(vectors.map((v) => [v.candidateId, v.vector] as const));

  type ClusterInfo = { id: string; size: number; repVec: Float32Array | null };
  const info: ClusterInfo[] = clusters.map((c) => {
    const rep = db
      .prepare(
        `SELECT candidate_id FROM l3_cluster_members
         WHERE run_id=? AND cluster_id=? AND is_representative=1 LIMIT 1`,
      )
      .get(runId, c.cluster_id) as { candidate_id: number } | undefined;
    const vec = rep ? vecByCandidate.get(rep.candidate_id) ?? null : null;
    return { id: c.cluster_id, size: c.size, repVec: vec };
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

  let pages = 0;
  let absorbed = 0;

  db.transaction(() => {
    db.prepare(`DELETE FROM nec_decisions WHERE run_id=?`).run(runId);

    for (const c of info) {
      if (c.size >= 2) {
        ins.run(runId, c.id, 'page', 'cluster size >= 2', null);
        pages++;
        continue;
      }
      // size=1 → 最も近い別クラスタへ吸収
      if (!c.repVec) {
        ins.run(runId, c.id, 'page', 'singleton kept (no vector to compare)', null);
        pages++;
        continue;
      }
      let bestId: string | null = null;
      let bestSim = -1;
      for (const other of info) {
        if (other.id === c.id || !other.repVec) continue;
        if (other.size < 2) continue; // 吸収先は ≥2 のみ
        const s = cosine(c.repVec, other.repVec);
        if (s > bestSim) {
          bestSim = s;
          bestId = other.id;
        }
      }
      if (bestId === null) {
        ins.run(runId, c.id, 'page', 'singleton kept (no absorption target)', null);
        pages++;
        continue;
      }
      ins.run(
        runId,
        c.id,
        'passage_absorbed',
        `singleton absorbed into ${bestId} (cosine=${bestSim.toFixed(3)})`,
        bestId,
      );
      updateCluster.run('absorbed', bestId, runId, c.id);
      absorbed++;
    }
  })();

  logger.info({ runId, totalClusters: info.length, pages, absorbed }, '[NEC] done');
  return { totalClusters: info.length, pages, absorbed };
}
