/**
 * [L3] SERPクラスタリング (Koray法準拠):
 *   辺 = (SERP重複≥serp_overlap_n) ∩ (cosine≥cosine_threshold) を満たす候補ペア
 *   union-find → 連結成分 → クラスタ = ページ単位候補
 *
 * 入力: density signal で in-region と判定された候補のみを対象
 * 出力: l3_clusters / l3_cluster_members
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
  cacheKey: string;
  topUrls: Set<string>;
}

function loadInRegion(runId: string): InRegionCand[] {
  // density signal の source_meta_json から candidateId を取得
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

  const vectors = loadRunVectors(runId).filter((v) => inRegionIds.has(v.candidateId));

  // 各候補のcache_key
  const fpRows = kwDb()
    .prepare(
      `SELECT lf.candidate_id, lf.cache_key
       FROM l2_serp_fp lf
       JOIN l1_candidates lc ON lc.id = lf.candidate_id
       WHERE lc.run_id=?`,
    )
    .all(runId) as Array<{ candidate_id: number; cache_key: string }>;
  const cacheByCand = new Map(fpRows.map((r) => [r.candidate_id, r.cache_key] as const));

  // 各cache_key の top URLs
  const urlStmt = serpCacheDb().prepare(
    'SELECT url FROM serp_top_urls WHERE cache_key=? ORDER BY rank LIMIT 10',
  );

  const out: InRegionCand[] = [];
  for (const v of vectors) {
    const ck = cacheByCand.get(v.candidateId);
    if (!ck) continue;
    const urls = (urlStmt.all(ck) as Array<{ url: string }>).map((x) => x.url);
    if (urls.length === 0) continue;
    out.push({
      candidateId: v.candidateId,
      keyword: v.keyword,
      vector: v.vector,
      cacheKey: ck,
      topUrls: new Set(urls),
    });
  }
  return out;
}

export interface L3Result {
  thresholds: { serpOverlapN: number; cosineThreshold: number };
  inRegion: number;
  edges: number;
  clusters: number;
  singletons: number;
  largestCluster: number;
}

export async function runL3(runId: string): Promise<L3Result> {
  const th = thresholds();
  const inRegion = loadInRegion(runId);
  const n = inRegion.length;
  if (n === 0) {
    return {
      thresholds: { serpOverlapN: th.serpOverlapN, cosineThreshold: th.cosineThreshold },
      inRegion: 0,
      edges: 0,
      clusters: 0,
      singletons: 0,
      largestCluster: 0,
    };
  }

  const uf = new UnionFind(n);
  let edges = 0;
  // 辺判定: O(n^2/2). n=180 で ~16k pair → 数十ms程度
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // SERP重複
      let inter = 0;
      const setI = inRegion[i]!.topUrls;
      const setJ = inRegion[j]!.topUrls;
      for (const u of setI) if (setJ.has(u)) inter++;
      if (inter < th.serpOverlapN) continue;
      // cosine
      const c = cosine(inRegion[i]!.vector, inRegion[j]!.vector);
      if (c < th.cosineThreshold) continue;
      uf.union(i, j);
      edges++;
    }
  }

  // 連結成分集約
  const compMap = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!compMap.has(root)) compMap.set(root, []);
    compMap.get(root)!.push(i);
  }
  const components = [...compMap.values()].sort((a, b) => b.length - a.length);

  // 永続化
  const db = kwDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM l3_cluster_members WHERE run_id=?`).run(runId);
    db.prepare(`DELETE FROM l3_clusters WHERE run_id=?`).run(runId);

    const insClu = db.prepare(
      `INSERT INTO l3_clusters (run_id, cluster_id, representative_kw, size, metric_json, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
    );
    const insMem = db.prepare(
      `INSERT INTO l3_cluster_members (run_id, cluster_id, candidate_id, is_representative)
       VALUES (?, ?, ?, ?)`,
    );

    for (let idx = 0; idx < components.length; idx++) {
      const members = components[idx]!;
      const clusterId = `c_${String(idx + 1).padStart(4, '0')}`;
      const memberDocs = members.map((mi) => inRegion[mi]!);

      // 代表 = 内部 cosine sum 最大 (近似的中心)
      let bestIdx = 0;
      let bestScore = -Infinity;
      for (let a = 0; a < members.length; a++) {
        let s = 0;
        for (let b = 0; b < members.length; b++) {
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
        members.length <= 1
          ? null
          : bestScore / (members.length - 1);

      insClu.run(
        runId,
        clusterId,
        rep.keyword,
        members.length,
        JSON.stringify({ avgCentralCosine: avgCos }),
      );
      for (let k = 0; k < memberDocs.length; k++) {
        insMem.run(runId, clusterId, memberDocs[k]!.candidateId, k === bestIdx ? 1 : 0);
      }
    }
  })();

  const singletons = components.filter((c) => c.length === 1).length;
  const largest = components[0]?.length ?? 0;

  logger.info(
    {
      runId,
      thresholds: { N: th.serpOverlapN, T: th.cosineThreshold },
      inRegion: n,
      edges,
      clusters: components.length,
      singletons,
      largest,
    },
    '[L3] clustering done',
  );

  return {
    thresholds: { serpOverlapN: th.serpOverlapN, cosineThreshold: th.cosineThreshold },
    inRegion: n,
    edges,
    clusters: components.length,
    singletons,
    largestCluster: largest,
  };
}
