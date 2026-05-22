import React, { useEffect, useMemo, useState } from 'react';

interface Node {
  page_id: string;
  title_hint: string | null;
  cover_size: number;
  bucket: string | null;
  intent_layer: string | null;
  parent_page_id: string | null;
  depth: number | null;
  edge_type: string | null;
  pagerank: number | null;
}

export function TopicalTab({ runId }: { runId: string }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/dashboard/${runId}/topical`)
      .then((r) => r.json())
      .then((d: { nodes: Node[] }) => {
        setNodes(d.nodes);
        setLoading(false);
      });
  }, [runId]);

  // 親子をtree化
  const tree = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.page_id, n]));
    const children = new Map<string | null, Node[]>();
    for (const n of nodes) {
      const key = n.parent_page_id ?? null;
      if (!children.has(key)) children.set(key, []);
      children.get(key)!.push(n);
    }
    for (const arr of children.values()) {
      arr.sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0));
    }
    return { byId, children };
  }, [nodes]);

  if (loading) return <div className="loading">topical map loading…</div>;
  const roots = tree.children.get(null) ?? [];

  function renderNode(n: Node, depth = 0): React.ReactElement {
    const kids = tree.children.get(n.page_id) ?? [];
    return (
      <div key={n.page_id} className="tree-node" style={{ marginLeft: depth * 12 }}>
        <div>
          <span className="rep">{n.title_hint}</span>
          {n.bucket && (
            <span className="badge badge-bucket" style={{ marginLeft: 6 }}>
              {n.bucket}
            </span>
          )}
          {n.intent_layer && (
            <span className={`badge badge-intent-${n.intent_layer}`} style={{ marginLeft: 4 }}>
              {n.intent_layer}
            </span>
          )}
        </div>
        <div className="meta">
          {n.page_id} · cover {n.cover_size}
          {n.pagerank ? ` · PR ${n.pagerank.toFixed(4)}` : ''}
          {n.edge_type && ` · ${n.edge_type}`}
        </div>
        {kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  }

  return (
    <div className="tree-wrap">
      <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        ROOT → axis sub-hubs → leaves。各nodeのPRは [L5] PageRank由来。
      </div>
      {roots.map((r) => renderNode(r))}
    </div>
  );
}
