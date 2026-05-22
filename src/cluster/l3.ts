/**
 * [L3] 軸事前分類 (AX) 経由のSERPクラスタリング (Koray法準拠 + 軸直交分離):
 *
 *   1. in-region 候補 (density signal判定) を [AX] のバケットに振り分け:
 *        - 0軸/core → 'core:' バケット
 *        - 1軸単純 → '<axis>:<value>' バケット (例: 'location:東京')
 *        - 2+軸     → bridge (一旦保留・後段で passage として最近接クラスタに吸収)
 *   2. 各バケット内で union-find: (SERP重複≥serp_overlap_n) ∩ (cosine≥cosine_threshold)
 *   3. bridge を後付け追加: 最大cosineクラスタに is_representative=0 のメンバとして吸収
 *   4. 代表KWは pure (非bridge) メンバから選出 (bridge は代表になれない)
 *
 * 仕様 §4 rev 2026-05-22-2: 軸 (location/cost/drug/audience/format/condition/trust/informational)
 * は直交し並列。bridgeはpassage_absorbed相当。
 */
import { kwDb, serpCacheDb } from '../lib/db.js';
import { cosine } from '../lib/voyage.js';
import { loadRunVectors } from '../lib/embeddings.js';
import { thresholds } from '../boundary/thresholds.js';
import { logger } from '../lib/logger.js';

class UnionFind {
  parent: number[];
  rank: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }
  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]!);
    return this.parent[x]!;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra]! < this.rank[rb]!) this.parent[ra] = rb;
    else if (this.rank[ra]! > this.rank[rb]!) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra]!++;
    }
  }
}

interface InRegionCand {
  candidateId: number;
  keyword: string;
  vector: Float32Array;
  topUrls: Set<string>;
  bucket: string | null; // null = unclassified or bridge (not in any pure bucket)
  isBridge: boolean;
}

function bucketForCandidate(
  axes: Array<{ axis: string; axis_value: string | null }>,
): { bucket: string | null; isBridge: boolean } {
  if (axes.length === 0) return { bucket: 'core:', isBridge: false };
  const nonCore = axes.filter((a) => a.axis !== 'core');
  if (nonCore.length === 0) return { bucket: 'core:', isBridge: false };
  const distinct = new Set(nonCore.map((a) => `${a.axis}:${a.axis_value ?? ''}`));
  if (distinct.size >= 2) return { bucket: null, isBridge: true };
  return { bucket: [...distinct][0]!, isBridge: false };
}

function loadInRegion(runId: string): InRegionCand[] {
  const densityRows = kwDb()
    .prepare(
      `SELECT json_extract(source_meta_json, '$.candidateId') AS cid
       FROM boundary_signals
       WHERE run_id=? AND signal_kind='density'`,
    )
    .all(runId) as Array<{ cid: number | null }>;
  const inRegionIds = new Set(
    densityRows.map((r) => r.cid).filter((v): v is number => typeof v === 'number'),
  );
  if (inRegionIds.size === 0) return [];

  // 意図フィルタで除外された候補は L3 clustering 対象外
  const filteredIds = new Set(
    (
      kwDb()
        .prepare(`SELECT candidate_id FROM candidate_filters WHERE run_id=?`)
        .all(runId) as Array<{ candidate_id: number }>
    ).map((r) => r.candidate_id),
  );

  const vectors = loadRunVectors(runId).filter(
    (v) => inRegionIds.has(v.candidateId) && !filteredIds.has(v.candidateId),
  );
  const fpRows = kwDb()
    .prepare(
      `SELECT lf.candidate_id, lf.cache_key
       FROM l2_serp_fp lf
       JOIN l1_candidates lc ON lc.id = lf.candidate_id
       WHERE lc.run_id=?`,
    )
    .all(runId) as Array<{ candidate_id: number; cache_key: string }>;
  const cacheByCand = new Map(fpRows.map((r) => [r.candidate_id, r.cache_key] as const));

  const urlStmt = serpCacheDb().prepare(
    'SELECT url FROM serp_top_urls WHERE cache_key=? ORDER BY rank LIMIT 10',
  );

  // 軸を一括ロード
  const axisRows = kwDb()
    .prepare(
      `SELECT ca.candidate_id, ca.axis, ca.axis_value
       FROM candidate_axes ca
       JOIN l1_candidates lc ON lc.id=ca.candidate_id
       WHERE lc.run_id=?`,
    )
    .all(runId) as Array<{ candidate_id: number; axis: string; axis_value: string | null }>;
  const axesByCand = new Map<number, Array<{ axis: string; axis_value: string | null }>>();
  for (const r of axisRows) {
    if (!axesByCand.has(r.candidate_id)) axesByCand.set(r.candidate_id, []);
    axesByCand.get(r.candidate_id)!.push({ axis: r.axis, axis_value: r.axis_value });
  }

  const out: InRegionCand[] = [];
  for (const v of vectors) {
    const ck = cacheByCand.get(v.candidateId);
    if (!ck) continue;
    const urls = (urlStmt.all(ck) as Array<{ url: string }>).map((x) => x.url);
    if (urls.length === 0) continue;
    const { bucket, isBridge } = bucketForCandidate(axesByCand.get(v.candidateId) ?? []);
    out.push({
      candidateId: v.candidateId,
      keyword: v.keyword,
      vector: v.vector,
      topUrls: new Set(urls),
      bucket,
      isBridge,
    });
  }
  return out;
}

export interface L3Result {
  thresholds: { serpOverlapN: number; cosineThreshold: number };
  inRegion: number;
  buckets: Record<string, { members: number; clusters: number; largest: number }>;
  bridgesAssigned: number;
  bridgesUnassigned: number;
  clustersTotal: number;
  pages: number; // size >= 2 (NEC前提準備)
  singletons: number;
}

export async function runL3(runId: string): Promise<L3Result> {
  const th = thresholds();
  const all = loadInRegion(runId);
  if (all.length === 0) {
    return {
      thresholds: { serpOverlapN: th.serpOverlapN, cosineThreshold: th.cosineThreshold },
      inRegion: 0,
      buckets: {},
      bridgesAssigned: 0,
      bridgesUnassigned: 0,
      clustersTotal: 0,
      pages: 0,
      singletons: 0,
    };
  }

  // バケット振り分け
  const pure = all.filter((c) => !c.isBridge);
  const bridges = all.filter((c) => c.isBridge);
  const byBucket = new Map<string, InRegionCand[]>();
  for (const c of pure) {
    const b = c.bucket ?? 'core:';
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b)!.push(c);
  }

  // 永続化準備
  const db = kwDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM l3_cluster_members WHERE run_id=?`).run(runId);
    db.prepare(`DELETE FROM l3_clusters WHERE run_id=?`).run(runId);
  })();

  const insClu = db.prepare(
    `INSERT INTO l3_clusters (run_id, cluster_id, representative_kw, size, metric_json, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
  );
  const insMem = db.prepare(
    `INSERT INTO l3_cluster_members (run_id, cluster_id, candidate_id, is_representative)
     VALUES (?, ?, ?, ?)`,
  );

  let clusterCounter = 0;
  const bucketStats: L3Result['buckets'] = {};
  // 後でbridge配賦するため、各クラスタの代表ベクトルとidを保持
  const clusterReps: Array<{ clusterId: string; bucket: string; repVec: Float32Array; size: number }> = [];

  for (const [bucket, members] of byBucket) {
    const n = members.length;
    if (n === 0) continue;

    // 仕様§4 rev 2026-05-22-2: 正規化後のバケット = 1クラスタ (バケット内 SERP+cosine 再分割は廃止)
    // 理由: axis_value canonical で「同一SEOエンティティ」と既に判定済み。SERP分散は意図差ではなく
    //       競合記事構成の差。Daikiの指摘「同じエンティティで違うワードは1つにくくりたい」を遵守。
    // 旧: union-find by (SERP重複≥N) ∩ (cosine≥T) ← 廃止
    const components: number[][] = [Array.from({ length: n }, (_, i) => i)];

    db.transaction(() => {
      for (const comp of components) {
        clusterCounter++;
        const clusterId = `c_${String(clusterCounter).padStart(4, '0')}`;
        const memberDocs = comp.map((mi) => members[mi]!);

        // 代表 = 内部cosine sum最大 (純メンバのみ)
        let bestIdx = 0;
        let bestScore = -Infinity;
        for (let a = 0; a < memberDocs.length; a++) {
          let s = 0;
          for (let b = 0; b < memberDocs.length; b++) {
            if (a === b) continue;
            s += cosine(memberDocs[a]!.vector, memberDocs[b]!.vector);
          }
          if (s > bestScore) {
            bestScore = s;
            bestIdx = a;
          }
        }
        const rep = memberDocs[bestIdx]!;
        const avgCos =
          memberDocs.length <= 1 ? null : bestScore / (memberDocs.length - 1);

        insClu.run(
          runId,
          clusterId,
          rep.keyword,
          memberDocs.length,
          JSON.stringify({ avgCentralCosine: avgCos, bucket }),
        );
        for (let k = 0; k < memberDocs.length; k++) {
          insMem.run(runId, clusterId, memberDocs[k]!.candidateId, k === bestIdx ? 1 : 0);
        }
        clusterReps.push({
          clusterId,
          bucket,
          repVec: rep.vector,
          size: memberDocs.length,
        });
      }
    })();

    const compsSorted = components.sort((a, b) => b.length - a.length);
    bucketStats[bucket] = {
      members: n,
      clusters: components.length,
      largest: compsSorted[0]?.length ?? 0,
    };
  }

  // bridges を最近接クラスタに配賦 (passage相当).
  // 仕様§4 rev: bridge は自分の軸 (1+) に一致する bucket を優先 (axis-match preference).
  //   同軸バケット内 max-cosine → 全体 max-cosine の順で fallback.
  let bridgesAssigned = 0;
  let bridgesUnassigned = 0;
  if (bridges.length > 0 && clusterReps.length > 0) {
    // bridge ごとの所属 bucket 集合をロード
    const bridgeAxesStmt = kwDb().prepare(
      `SELECT axis, axis_value FROM candidate_axes WHERE candidate_id=?`,
    );
    const bridgeBuckets = new Map<number, Set<string>>();
    for (const br of bridges) {
      const rows = bridgeAxesStmt.all(br.candidateId) as Array<{
        axis: string;
        axis_value: string;
      }>;
      const set = new Set<string>();
      for (const r of rows) set.add(`${r.axis}:${r.axis_value}`);
      bridgeBuckets.set(br.candidateId, set);
    }
    db.transaction(() => {
      for (const br of bridges) {
        const myBuckets = bridgeBuckets.get(br.candidateId) ?? new Set<string>();
        let bestMatchSim = -1;
        let bestMatchClu: typeof clusterReps[number] | null = null;
        let bestAnySim = -1;
        let bestAnyClu: typeof clusterReps[number] | null = null;
        for (const c of clusterReps) {
          const s = cosine(br.vector, c.repVec);
          if (myBuckets.has(c.bucket)) {
            if (s > bestMatchSim) {
              bestMatchSim = s;
              bestMatchClu = c;
            }
          }
          if (s > bestAnySim) {
            bestAnySim = s;
            bestAnyClu = c;
          }
        }
        const softTh = th.cosineThreshold * 0.85;
        const target =
          bestMatchClu && bestMatchSim >= softTh
            ? bestMatchClu
            : bestAnyClu && bestAnySim >= softTh
              ? bestAnyClu
              : null;
        if (target) {
          insMem.run(runId, target.clusterId, br.candidateId, 0);
          db.prepare(
            `UPDATE l3_clusters SET size=size+1 WHERE run_id=? AND cluster_id=?`,
          ).run(runId, target.clusterId);
          bridgesAssigned++;
        } else {
          bridgesUnassigned++;
        }
      }
    })();
  } else {
    bridgesUnassigned = bridges.length;
  }

  // 最終統計
  const sizes = (
    db
      .prepare(`SELECT size FROM l3_clusters WHERE run_id=? AND status='active'`)
      .all(runId) as Array<{ size: number }>
  ).map((r) => r.size);
  const pages = sizes.filter((s) => s >= 2).length;
  const singletons = sizes.filter((s) => s === 1).length;

  logger.info(
    {
      runId,
      thresholds: { N: th.serpOverlapN, T: th.cosineThreshold },
      inRegion: all.length,
      pureCandidates: pure.length,
      bridges: bridges.length,
      bridgesAssigned,
      bridgesUnassigned,
      buckets: Object.fromEntries(Object.entries(bucketStats)),
      clustersTotal: clusterCounter,
    },
    '[L3] axis-aware clustering done',
  );

  return {
    thresholds: { serpOverlapN: th.serpOverlapN, cosineThreshold: th.cosineThreshold },
    inRegion: all.length,
    buckets: bucketStats,
    bridgesAssigned,
    bridgesUnassigned,
    clustersTotal: clusterCounter,
    pages,
    singletons,
  };
}
