/**
 * [L4] 階層 (hub/spoke):
 *   - ROOT hub = silo中心 centroid に最も近い page (= core: バケットの最大 cover page を優先)
 *   - 各 axis (location/cost/drug/...) は sub-hub = その軸内 最大 cover page
 *   - 各 page の親 = 同 axis の sub-hub (またはROOT)
 *
 * Output: l4_hierarchy(page_id, parent_page_id, depth, edge_type, cosine_to_parent)
 */
import { kwDb } from '../lib/db.js';
import { cosine } from '../lib/voyage.js';
import { loadRunVectors, centroid } from '../lib/embeddings.js';
import { logger } from '../lib/logger.js';

interface PageNode {
  pageId: string;
  clusterId: string;
  bucket: string; // 'core:' | 'location:東京' | ...
  axisKey: string; // 'core' | 'location' | 'cost' | ...
  coverSize: number;
  centroid: Float32Array;
}

function axisKeyFromBucket(bucket: string | null): string {
  if (!bucket) return 'unknown';
  const colon = bucket.indexOf(':');
  return colon < 0 ? bucket : bucket.slice(0, colon);
}

function computePageCentroids(runId: string): PageNode[] {
  const db = kwDb();
  const pages = db
    .prepare(
      `SELECT cp.page_id, cp.cluster_id, cp.cover_size, json_extract(c.metric_json,'$.bucket') AS bucket
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       WHERE cp.run_id=?`,
    )
    .all(runId) as Array<{ page_id: string; cluster_id: string; cover_size: number; bucket: string | null }>;

  const vectors = loadRunVectors(runId);
  const vecMap = new Map(vectors.map((v) => [v.candidateId, v.vector] as const));

  const nodes: PageNode[] = [];
  for (const p of pages) {
    const members = db
      .prepare(
        `SELECT candidate_id FROM l3_cluster_members WHERE run_id=? AND cluster_id=?`,
      )
      .all(runId, p.cluster_id) as Array<{ candidate_id: number }>;
    const vecs = members.map((m) => vecMap.get(m.candidate_id)).filter((v): v is Float32Array => !!v);
    if (vecs.length === 0) continue;
    const c = centroid(vecs);
    nodes.push({
      pageId: p.page_id,
      clusterId: p.cluster_id,
      bucket: p.bucket ?? 'unknown:',
      axisKey: axisKeyFromBucket(p.bucket),
      coverSize: p.cover_size,
      centroid: c,
    });
  }
  return nodes;
}

export interface L4HierarchyResult {
  totalPages: number;
  rootPageId: string | null;
  axisHubs: Array<{ axisKey: string; pageId: string; size: number }>;
  leaves: number;
}

export async function runL4Hierarchy(runId: string): Promise<L4HierarchyResult> {
  const nodes = computePageCentroids(runId);
  if (nodes.length === 0) {
    return { totalPages: 0, rootPageId: null, axisHubs: [], leaves: 0 };
  }

  // 1. silo centroid
  const siloCent = centroid(nodes.map((n) => n.centroid));

  // 2. ROOT = core: バケット内最大 cover_size の page (なければ siloCentに最も近い page)
  let root: PageNode | undefined = nodes
    .filter((n) => n.axisKey === 'core')
    .sort((a, b) => b.coverSize - a.coverSize)[0];
  if (!root) {
    let bestScore = -Infinity;
    for (const n of nodes) {
      const s = cosine(n.centroid, siloCent);
      if (s > bestScore) {
        bestScore = s;
        root = n;
      }
    }
  }
  if (!root) throw new Error('[L4] cannot determine root');

  // 3. axis sub-hubs (axisKey ごとに最大 cover_size の page。core は root が hub)
  const axisHubs = new Map<string, PageNode>();
  axisHubs.set('core', root);
  for (const n of nodes) {
    if (n.axisKey === 'core') continue;
    const cur = axisHubs.get(n.axisKey);
    if (!cur || n.coverSize > cur.coverSize) axisHubs.set(n.axisKey, n);
  }

  // 4. 各 page の parent 決定 + 永続化
  const db = kwDb();
  const ins = db.prepare(
    `INSERT INTO l4_hierarchy (run_id, page_id, parent_page_id, depth, edge_type, cosine_to_parent)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, page_id) DO UPDATE SET
       parent_page_id=excluded.parent_page_id, depth=excluded.depth,
       edge_type=excluded.edge_type, cosine_to_parent=excluded.cosine_to_parent`,
  );

  let leaves = 0;
  db.transaction(() => {
    db.prepare(`DELETE FROM l4_hierarchy WHERE run_id=?`).run(runId);
    for (const n of nodes) {
      if (n.pageId === root!.pageId) {
        ins.run(runId, n.pageId, null, 0, 'root', null);
        continue;
      }
      const hub = axisHubs.get(n.axisKey);
      if (hub && hub.pageId !== n.pageId) {
        const cos = cosine(n.centroid, hub.centroid);
        ins.run(runId, n.pageId, hub.pageId, 2, 'spoke', cos);
        leaves++;
      } else if (hub && hub.pageId === n.pageId) {
        // 自身が axis hub → parent = root
        const cos = cosine(n.centroid, root!.centroid);
        ins.run(runId, n.pageId, root!.pageId, 1, 'axis_hub', cos);
      } else {
        // hub 取得失敗 → root直結
        const cos = cosine(n.centroid, root!.centroid);
        ins.run(runId, n.pageId, root!.pageId, 1, 'spoke', cos);
        leaves++;
      }
    }
  })();

  const hubList = [...axisHubs.entries()]
    .filter(([k]) => k !== 'core')
    .map(([axisKey, p]) => ({ axisKey, pageId: p.pageId, size: p.coverSize }))
    .sort((a, b) => b.size - a.size);

  logger.info(
    { runId, total: nodes.length, root: root.pageId, axisHubs: hubList.length, leaves },
    '[L4] hierarchy built',
  );

  return { totalPages: nodes.length, rootPageId: root.pageId, axisHubs: hubList, leaves };
}
