/**
 * [L3-post] Cross-bucket cluster merge:
 *   軸事前分類で別バケットに振り分けられた cluster でも、
 *   (SERP重複 ≥ serp_overlap_n) ∩ (cosine ≥ cosine_threshold) を満たすペアは
 *   「同じSEO意図」と見なし統合する (小→大 absorbed_into)。
 *
 * 経緯 (Daiki指摘): 「aga 治療おすすめ」(core:) と「aga おすすめクリニック」(format:クリニック)
 * は同じ意図だが、Claudeの軸分類で別バケットに入って分裂していた。
 * cosine 0.962, SERP overlap 4 URL → 統合すべきと判定される。
 *
 * brand軸はNEC側で別途auto-absorbするので、ここでは brand bucket 同士の merge は除外。
 */
import { kwDb, serpCacheDb } from '../lib/db.js';
import { cosine } from '../lib/voyage.js';
import { loadRunVectors } from '../lib/embeddings.js';
import { thresholds } from '../boundary/thresholds.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

interface ActiveCluster {
  cluster_id: string;
  size: number;
  bucket: string;
  isBrand: boolean;
  rep_vec: Float32Array | null;
  rep_urls: Set<string>;
}

export interface PostMergeResult {
  evaluatedPairs: number;
  merged: number;
  samples: Array<{ from: string; into: string; bucket_from: string; bucket_into: string; cos: number; overlap: number }>;
}

export async function runPostL3Merge(runId: string): Promise<PostMergeResult> {
  const db = kwDb();
  const th = thresholds();

  const rows = db
    .prepare(
      `SELECT c.cluster_id, c.size, json_extract(c.metric_json,'$.bucket') AS bucket
       FROM l3_clusters c
       WHERE c.run_id=? AND c.status='active'`,
    )
    .all(runId) as Array<{ cluster_id: string; size: number; bucket: string | null }>;

  if (rows.length < 2) {
    return { evaluatedPairs: 0, merged: 0, samples: [] };
  }

  // 各クラスタの代表 (rep) candidateベクトル + top URL集合をロード
  const vectors = loadRunVectors(runId);
  const vecMap = new Map(vectors.map((v) => [v.candidateId, v.vector] as const));

  const clusters: ActiveCluster[] = [];
  for (const r of rows) {
    const rep = db
      .prepare(
        `SELECT candidate_id FROM l3_cluster_members
         WHERE run_id=? AND cluster_id=? AND is_representative=1 LIMIT 1`,
      )
      .get(runId, r.cluster_id) as { candidate_id: number } | undefined;
    if (!rep) continue;
    const vec = vecMap.get(rep.candidate_id) ?? null;
    const ck = (
      db
        .prepare(`SELECT cache_key FROM l2_serp_fp WHERE candidate_id=?`)
        .get(rep.candidate_id) as { cache_key: string } | undefined
    )?.cache_key;
    const urls = ck
      ? new Set(
          (
            serpCacheDb()
              .prepare(
                `SELECT url FROM serp_top_urls WHERE cache_key=? ORDER BY rank LIMIT 10`,
              )
              .all(ck) as Array<{ url: string }>
          ).map((u) => u.url),
        )
      : new Set<string>();
    clusters.push({
      cluster_id: r.cluster_id,
      size: r.size,
      bucket: r.bucket ?? 'unknown:',
      isBrand: (r.bucket ?? '').startsWith('brand:'),
      rep_vec: vec,
      rep_urls: urls,
    });
  }

  // size desc にソートして大きい順に探索
  clusters.sort((a, b) => b.size - a.size);

  // Union-find (union-by-size: 常に大きいrootが親になる) for transitive merges
  const parent = new Map<string, string>();
  const sizeMap = new Map<string, number>();
  const bucketMap = new Map<string, string>();
  for (const c of clusters) {
    parent.set(c.cluster_id, c.cluster_id);
    sizeMap.set(c.cluster_id, c.size);
    bucketMap.set(c.cluster_id, c.bucket);
  }
  const find = (x: string): string => {
    const p = parent.get(x)!;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  /** 大きい root が親になる。返り値 = 統合後の root */
  const union = (a: string, b: string): { root: string; child: string } | null => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return null;
    const sa = sizeMap.get(ra)!;
    const sb = sizeMap.get(rb)!;
    if (sa >= sb) {
      parent.set(rb, ra);
      sizeMap.set(ra, sa + sb);
      return { root: ra, child: rb };
    }
    parent.set(ra, rb);
    sizeMap.set(rb, sa + sb);
    return { root: rb, child: ra };
  };

  let evaluated = 0;
  const samples: PostMergeResult['samples'] = [];

  for (let i = 0; i < clusters.length; i++) {
    const a = clusters[i]!;
    if (!a.rep_vec || a.rep_urls.size === 0) continue;
    for (let j = i + 1; j < clusters.length; j++) {
      const b = clusters[j]!;
      if (!b.rep_vec || b.rep_urls.size === 0) continue;
      // 同bucketは既にL3で処理済 → skip
      if (a.bucket === b.bucket) continue;
      // brand同士は別途NECで処理 → skip (brand vs non-brand は許可)
      if (a.isBrand && b.isBrand) continue;
      evaluated++;
      let inter = 0;
      for (const u of a.rep_urls) if (b.rep_urls.has(u)) inter++;
      if (inter < th.serpOverlapN) continue;
      const c = cosine(a.rep_vec, b.rep_vec);
      if (c < th.cosineThreshold) continue;
      const r = union(a.cluster_id, b.cluster_id);
      if (!r) continue;
      samples.push({
        from: r.child,
        into: r.root,
        bucket_from: bucketMap.get(r.child) ?? '',
        bucket_into: bucketMap.get(r.root) ?? '',
        cos: Number(c.toFixed(3)),
        overlap: inter,
      });
    }
  }

  // 実DB反映: 各クラスタを最終rootに吸収させる
  let mergedCount = 0;
  db.transaction(() => {
    // size を最終 root に集計するため、root別に増分を計算
    const sizeIncBy = new Map<string, number>();
    for (const c of clusters) {
      const r = find(c.cluster_id);
      if (r === c.cluster_id) continue;
      // c は root r に吸収される
      db.prepare(
        `UPDATE l3_clusters SET status='absorbed', absorbed_into=? WHERE run_id=? AND cluster_id=?`,
      ).run(r, runId, c.cluster_id);
      sizeIncBy.set(r, (sizeIncBy.get(r) ?? 0) + c.size);
      mergedCount++;
    }
    for (const [r, inc] of sizeIncBy) {
      db.prepare(`UPDATE l3_clusters SET size=size+? WHERE run_id=? AND cluster_id=?`).run(inc, runId, r);
    }

    // === Chain flatten ===
    // NEC absorbed_into → postMerge absorbed_into のチェーン (A→B→C) を全て A→C へ平坦化。
    // COV の pageEntityKeys は1-level absorbed_into JOIN なので、これでチェーン全体が
    // 正しく page にカバーされる。
    const allRows = db
      .prepare(
        `SELECT cluster_id, absorbed_into, status FROM l3_clusters WHERE run_id=?`,
      )
      .all(runId) as Array<{ cluster_id: string; absorbed_into: string | null; status: string }>;
    const ptr = new Map<string, string | null>();
    for (const r of allRows) ptr.set(r.cluster_id, r.absorbed_into);
    const root = (x: string): string => {
      let cur = x;
      const seen = new Set<string>();
      while (true) {
        const p = ptr.get(cur);
        if (!p || p === cur) return cur;
        if (seen.has(p)) return cur; // cycle防止
        seen.add(p);
        cur = p;
      }
    };
    const flat = db.prepare(
      `UPDATE l3_clusters SET absorbed_into=? WHERE run_id=? AND cluster_id=?`,
    );
    for (const r of allRows) {
      if (!r.absorbed_into) continue;
      const ult = root(r.absorbed_into);
      if (ult !== r.absorbed_into) flat.run(ult, runId, r.cluster_id);
    }
  })();

  audit({
    actor: 'system',
    eventType: 'l3.post_merge.complete',
    entityType: 'run',
    entityId: runId,
    after: { evaluatedPairs: evaluated, merged: mergedCount, sampleSize: Math.min(samples.length, 20) },
  });

  logger.info(
    { runId, evaluated, merged: mergedCount, top: samples.slice(0, 5) },
    '[L3-post] cross-bucket merge done',
  );

  return { evaluatedPairs: evaluated, merged: mergedCount, samples: samples.slice(0, 50) };
}
