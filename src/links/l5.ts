/**
 * [L5] 内部リンク + PageRank フロー模擬:
 *
 *   ① structural: child → parent (L4階層由来)
 *   ② contextual: page centroid cosine ≥ threshold (config 'l5_contextual_min_cosine', default 0.7)
 *                 の上位 K (default 3) を双方向で張る
 *   ③ axis_cross: 各 page → silo ROOT (hub 連結)
 *
 *   PageRank: damping=0.85, max_iter=50, tol=1e-6
 */
import { kwDb } from '../lib/db.js';
import { cosine } from '../lib/voyage.js';
import { loadRunVectors, centroid } from '../lib/embeddings.js';
import { getConfigOr } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

interface PageNode {
  pageId: string;
  centroid: Float32Array;
}

function loadPageCentroids(runId: string): PageNode[] {
  const db = kwDb();
  const pages = db
    .prepare(`SELECT page_id, cluster_id FROM cov_pages WHERE run_id=?`)
    .all(runId) as Array<{ page_id: string; cluster_id: string }>;
  const vectors = loadRunVectors(runId);
  const vecMap = new Map(vectors.map((v) => [v.candidateId, v.vector] as const));
  const out: PageNode[] = [];
  for (const p of pages) {
    const members = db
      .prepare(
        `SELECT candidate_id FROM l3_cluster_members WHERE run_id=? AND cluster_id=?`,
      )
      .all(runId, p.cluster_id) as Array<{ candidate_id: number }>;
    const vecs = members.map((m) => vecMap.get(m.candidate_id)).filter((v): v is Float32Array => !!v);
    if (vecs.length === 0) continue;
    out.push({ pageId: p.page_id, centroid: centroid(vecs) });
  }
  return out;
}

export interface L5Result {
  totalPages: number;
  structuralLinks: number;
  contextualLinks: number;
  axisCrossLinks: number;
  pagerank: { iterations: number; converged: boolean; max: number; min: number };
}

export async function runL5(runId: string): Promise<L5Result> {
  const db = kwDb();
  const contextualMinCos = getConfigOr<number>('l5_contextual_min_cosine', 0.7);
  const contextualTopK = getConfigOr<number>('l5_contextual_top_k', 3);

  const nodes = loadPageCentroids(runId);
  if (nodes.length === 0) {
    return {
      totalPages: 0,
      structuralLinks: 0,
      contextualLinks: 0,
      axisCrossLinks: 0,
      pagerank: { iterations: 0, converged: false, max: 0, min: 0 },
    };
  }

  const ins = db.prepare(
    `INSERT INTO l5_links (run_id, source_page_id, target_page_id, link_type, weight, rationale)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, source_page_id, target_page_id, link_type) DO UPDATE SET
       weight=excluded.weight, rationale=excluded.rationale`,
  );

  // ① structural: l4_hierarchy から
  const hierRows = db
    .prepare(
      `SELECT page_id, parent_page_id, cosine_to_parent FROM l4_hierarchy
       WHERE run_id=? AND parent_page_id IS NOT NULL`,
    )
    .all(runId) as Array<{ page_id: string; parent_page_id: string; cosine_to_parent: number | null }>;
  let structuralLinks = 0;
  // ③ axis_cross 集計用
  const rootRow = db
    .prepare(`SELECT page_id FROM l4_hierarchy WHERE run_id=? AND parent_page_id IS NULL LIMIT 1`)
    .get(runId) as { page_id: string } | undefined;
  const rootPageId = rootRow?.page_id ?? null;

  db.transaction(() => {
    db.prepare(`DELETE FROM l5_links WHERE run_id=?`).run(runId);

    for (const h of hierRows) {
      ins.run(
        runId,
        h.page_id,
        h.parent_page_id,
        'structural',
        h.cosine_to_parent ?? 0.5,
        'L4階層の親へ',
      );
      structuralLinks++;
    }

    // ② contextual: 各 page の上位 K 類似 page
    let contextualLinks = 0;
    for (let i = 0; i < nodes.length; i++) {
      const sims: Array<{ targetIdx: number; cos: number }> = [];
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const c = cosine(nodes[i]!.centroid, nodes[j]!.centroid);
        if (c >= contextualMinCos) sims.push({ targetIdx: j, cos: c });
      }
      sims.sort((a, b) => b.cos - a.cos);
      const top = sims.slice(0, contextualTopK);
      for (const t of top) {
        ins.run(
          runId,
          nodes[i]!.pageId,
          nodes[t.targetIdx]!.pageId,
          'contextual',
          t.cos,
          `contextual cosine=${t.cos.toFixed(3)}`,
        );
        contextualLinks++;
      }
    }

    // ③ axis_cross: 各 page (root以外) → root
    let axisCrossLinks = 0;
    if (rootPageId) {
      for (const n of nodes) {
        if (n.pageId === rootPageId) continue;
        ins.run(
          runId,
          n.pageId,
          rootPageId,
          'axis_cross',
          0.5,
          'silo ROOT への axis_cross',
        );
        axisCrossLinks++;
      }
    }

    // 保存対象として上記カウントを外部で見えるよう、return側で再計測
  })();

  const contextualLinks = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM l5_links WHERE run_id=? AND link_type='contextual'`,
      )
      .get(runId) as { n: number }
  ).n;
  const axisCrossLinks = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM l5_links WHERE run_id=? AND link_type='axis_cross'`,
      )
      .get(runId) as { n: number }
  ).n;

  // ===== PageRank =====
  const pageIds = nodes.map((n) => n.pageId);
  const idxOf = new Map(pageIds.map((id, i) => [id, i] as const));
  const N = pageIds.length;
  // 隣接 (重み付き)
  const out: number[][] = Array.from({ length: N }, () => []);
  const weights: Array<Array<{ target: number; w: number }>> = Array.from(
    { length: N },
    () => [],
  );
  const allLinks = db
    .prepare(`SELECT source_page_id, target_page_id, weight FROM l5_links WHERE run_id=?`)
    .all(runId) as Array<{ source_page_id: string; target_page_id: string; weight: number }>;
  for (const e of allLinks) {
    const s = idxOf.get(e.source_page_id);
    const t = idxOf.get(e.target_page_id);
    if (s === undefined || t === undefined) continue;
    out[s]!.push(t);
    weights[s]!.push({ target: t, w: Math.max(0, e.weight) });
  }

  const damping = 0.85;
  const tol = 1e-6;
  const maxIter = 50;
  let pr = new Array(N).fill(1 / N);
  let iter = 0;
  let converged = false;
  for (iter = 1; iter <= maxIter; iter++) {
    const next = new Array(N).fill((1 - damping) / N);
    for (let s = 0; s < N; s++) {
      const sumW = weights[s]!.reduce((a, b) => a + b.w, 0);
      if (sumW === 0) {
        // dangling: 均等分配
        for (let t = 0; t < N; t++) next[t]! += (damping * pr[s]!) / N;
      } else {
        for (const ed of weights[s]!) {
          next[ed.target]! += damping * pr[s]! * (ed.w / sumW);
        }
      }
    }
    // 正規化
    const sum = next.reduce((a, b) => a + b, 0);
    if (sum > 0) for (let i = 0; i < N; i++) next[i] = next[i]! / sum;

    let delta = 0;
    for (let i = 0; i < N; i++) delta += Math.abs(next[i]! - pr[i]!);
    pr = next;
    if (delta < tol) {
      converged = true;
      break;
    }
  }

  // 永続化
  db.transaction(() => {
    db.prepare(`DELETE FROM l5_pagerank WHERE run_id=?`).run(runId);
    const insPr = db.prepare(
      `INSERT INTO l5_pagerank (run_id, page_id, score, iterations) VALUES (?, ?, ?, ?)`,
    );
    for (let i = 0; i < N; i++) insPr.run(runId, pageIds[i]!, pr[i]!, iter);
  })();

  const maxScore = Math.max(...pr);
  const minScore = Math.min(...pr);

  audit({
    actor: 'system',
    eventType: 'l5.complete',
    entityType: 'run',
    entityId: runId,
    after: {
      structuralLinks,
      contextualLinks,
      axisCrossLinks,
      pagerank: { iterations: iter, converged, max: maxScore, min: minScore },
    },
  });

  logger.info(
    {
      runId,
      pages: N,
      structural: structuralLinks,
      contextual: contextualLinks,
      axisCross: axisCrossLinks,
      pagerankIter: iter,
      converged,
    },
    '[L5] links + pagerank done',
  );

  return {
    totalPages: N,
    structuralLinks,
    contextualLinks,
    axisCrossLinks,
    pagerank: { iterations: iter, converged, max: maxScore, min: minScore },
  };
}
