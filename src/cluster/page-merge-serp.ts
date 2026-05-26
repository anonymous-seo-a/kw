/**
 * 修正B (spec-01): cross-bucket SERP page merge.
 *
 *   page rep (cluster representative) の上位N URL重複が config 'spec01_serp_merge_n' (default 3)
 *   を満たす page pair を1つに統合する。bucket境界を跨ぐマージを許可
 *   (= 同義意図の散逸防止)。union-by-size + path compression。
 *
 *   実行タイミング: NEC 後 (page = NEC='page' clusters 確定後)
 *   結果: l3_clusters.status='absorbed' + absorbed_into = root cluster
 *         + page_serp_merges に audit log 記録
 *         + absorbed_into chain flatten
 */
import { kwDb, serpCacheDb } from '../lib/db.js';
import { getConfigOr } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

interface PageClusterInfo {
  cluster_id: string;
  size: number;
  bucket: string;
  rep_kw: string;
  top_urls: Set<string>;
}

export interface PageMergeSerpResult {
  threshold: number;
  pagesBefore: number;
  pagesAfter: number;
  mergedPairs: number;
  evaluatedPairs: number;
}

export async function runPageMergeSerp(runId: string): Promise<PageMergeSerpResult> {
  const N = getConfigOr<number>('spec01_serp_merge_n', 3);
  const db = kwDb();

  // NEC='page' な active cluster (= pages) を取得 (NEC 後の状態)
  const pages = db
    .prepare(
      `SELECT c.cluster_id, c.size, c.absorbed_into,
              json_extract(c.metric_json,'$.bucket') AS bucket,
              cp.title_hint AS rep_kw
       FROM l3_clusters c
       JOIN cov_pages cp ON cp.run_id=c.run_id AND cp.cluster_id=c.cluster_id
       WHERE c.run_id=? AND c.status='active'`,
    )
    .all(runId) as Array<{ cluster_id: string; size: number; absorbed_into: string | null; bucket: string | null; rep_kw: string | null }>;

  if (pages.length < 2) {
    return { threshold: N, pagesBefore: pages.length, pagesAfter: pages.length, mergedPairs: 0, evaluatedPairs: 0 };
  }

  // 各 cluster の rep candidate と top URLs
  const repStmt = db.prepare(
    `SELECT candidate_id FROM l3_cluster_members
     WHERE run_id=? AND cluster_id=? AND is_representative=1 LIMIT 1`,
  );
  const ckStmt = db.prepare(`SELECT cache_key FROM l2_serp_fp WHERE candidate_id=?`);
  const urlStmt = serpCacheDb().prepare(
    `SELECT url FROM serp_top_urls WHERE cache_key=? ORDER BY rank LIMIT 10`,
  );

  const infos: PageClusterInfo[] = [];
  for (const p of pages) {
    const rep = repStmt.get(runId, p.cluster_id) as { candidate_id: number } | undefined;
    if (!rep) continue;
    const ck = (ckStmt.get(rep.candidate_id) as { cache_key: string } | undefined)?.cache_key;
    const urls = ck
      ? new Set((urlStmt.all(ck) as Array<{ url: string }>).map((r) => r.url))
      : new Set<string>();
    if (urls.size === 0) continue;
    infos.push({
      cluster_id: p.cluster_id,
      size: p.size,
      bucket: p.bucket ?? '',
      rep_kw: p.rep_kw ?? '',
      top_urls: urls,
    });
  }

  // size desc sort (大きい cluster を root に)
  infos.sort((a, b) => b.size - a.size);

  // union-find with union-by-size
  const parent = new Map<string, string>();
  const sizeMap = new Map<string, number>();
  for (const c of infos) {
    parent.set(c.cluster_id, c.cluster_id);
    sizeMap.set(c.cluster_id, c.size);
  }
  const find = (x: string): string => {
    const p = parent.get(x)!;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
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

  const insLog = db.prepare(
    `INSERT INTO page_serp_merges (run_id, from_cluster_id, into_cluster_id, overlap, bucket_from, bucket_into, rep_kw_from, rep_kw_into)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let mergedPairs = 0;
  let evaluated = 0;

  db.transaction(() => {
    db.prepare(`DELETE FROM page_serp_merges WHERE run_id=?`).run(runId);

    for (let i = 0; i < infos.length; i++) {
      const a = infos[i]!;
      for (let j = i + 1; j < infos.length; j++) {
        const b = infos[j]!;
        evaluated++;
        let ov = 0;
        for (const u of a.top_urls) if (b.top_urls.has(u)) ov++;
        if (ov < N) continue;
        const r = union(a.cluster_id, b.cluster_id);
        if (!r) continue;
        insLog.run(runId, r.child, r.root, ov, a.bucket, b.bucket, a.rep_kw, b.rep_kw);
        mergedPairs++;
      }
    }

    // DB反映: 各 cluster を最終 root に absorb
    const sizeIncBy = new Map<string, number>();
    for (const c of infos) {
      const r = find(c.cluster_id);
      if (r === c.cluster_id) continue;
      db.prepare(
        `UPDATE l3_clusters SET status='absorbed', absorbed_into=? WHERE run_id=? AND cluster_id=?`,
      ).run(r, runId, c.cluster_id);
      sizeIncBy.set(r, (sizeIncBy.get(r) ?? 0) + c.size);
    }
    for (const [r, inc] of sizeIncBy) {
      db.prepare(`UPDATE l3_clusters SET size=size+? WHERE run_id=? AND cluster_id=?`).run(inc, runId, r);
    }

    // Chain flatten (NEC absorbed_into → spec-01 absorbed_into 多段)
    const allRows = db
      .prepare(`SELECT cluster_id, absorbed_into FROM l3_clusters WHERE run_id=?`)
      .all(runId) as Array<{ cluster_id: string; absorbed_into: string | null }>;
    const ptr = new Map<string, string | null>(allRows.map((r) => [r.cluster_id, r.absorbed_into]));
    const root = (x: string): string => {
      let cur = x;
      const seen = new Set<string>();
      while (true) {
        const p = ptr.get(cur);
        if (!p || p === cur) return cur;
        if (seen.has(p)) return cur;
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

  // cov_pages 再構築 — NECで作られた cov_pages 行のうち absorbed になったものを除外
  // → setCoverage を後で再実行する必要あり (orchestrator側で)
  // ここでは「activeでない (absorbed)」 cov_pages 行は削除しないが、coverage step で再選ばれる
  const pagesAfter = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM l3_clusters c
         JOIN cov_pages cp ON cp.run_id=c.run_id AND cp.cluster_id=c.cluster_id
         WHERE c.run_id=? AND c.status='active'`,
      )
      .get(runId) as { n: number }
  ).n;

  audit({
    actor: 'system',
    eventType: 'page_merge_serp.complete',
    entityType: 'run',
    entityId: runId,
    after: { threshold: N, pagesBefore: pages.length, pagesAfter, mergedPairs, evaluated },
  });

  logger.info(
    { runId, threshold: N, pagesBefore: pages.length, pagesAfter, mergedPairs, evaluatedPairs: evaluated },
    '[B] cross-bucket SERP page merge done',
  );

  return { threshold: N, pagesBefore: pages.length, pagesAfter, mergedPairs, evaluatedPairs: evaluated };
}
