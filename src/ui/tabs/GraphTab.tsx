import React, { useEffect, useRef, useState } from 'react';

interface Node {
  page_id: string;
  title_hint: string | null;
  bucket: string | null;
  intent_layer: string | null;
  pagerank: number | null;
  cover_size: number;
}
interface Edge {
  source: string;
  target: string;
  link_type: 'structural' | 'contextual' | 'axis_cross';
  weight: number;
}

interface Sim {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const EDGE_COLOR: Record<string, string> = {
  structural: '#1565c0',
  contextual: '#2e7d32',
  axis_cross: '#bbb',
};

const BUCKET_COLOR: Record<string, string> = {
  core: '#1a1a2e',
  location: '#1565c0',
  format: '#6a1b9a',
  cost: '#ef6c00',
  trust: '#c2185b',
  drug: '#00838f',
  audience: '#558b2f',
  condition: '#5d4037',
  informational: '#283593',
  brand: '#b71c1c',
};

function bucketAxis(bucket: string | null): string {
  if (!bucket) return 'unknown';
  const c = bucket.indexOf(':');
  return c < 0 ? bucket : bucket.slice(0, c);
}

export function GraphTab({ runId }: { runId: string }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [hover, setHover] = useState<Node | null>(null);
  const [loading, setLoading] = useState(true);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const simRef = useRef<Map<string, Sim>>(new Map());
  const [, force] = useState(0);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/dashboard/${runId}/graph`)
      .then((r) => r.json())
      .then((d: { nodes: Node[]; edges: Edge[] }) => {
        setNodes(d.nodes);
        setEdges(d.edges);
        setLoading(false);
      });
  }, [runId]);

  // Force simulation (簡易・お手製)
  useEffect(() => {
    if (nodes.length === 0) return;
    const W = 1200;
    const H = 700;
    const sim = new Map<string, Sim>();
    nodes.forEach((n, i) => {
      const a = (i / nodes.length) * Math.PI * 2;
      sim.set(n.page_id, {
        x: W / 2 + Math.cos(a) * 250,
        y: H / 2 + Math.sin(a) * 250,
        vx: 0,
        vy: 0,
      });
    });
    simRef.current = sim;

    const charge = -80;
    const linkDist = 80;
    let iter = 0;
    const step = () => {
      iter++;
      // repulsion (charge)
      for (const a of nodes) {
        const sa = sim.get(a.page_id)!;
        sa.vx *= 0.7;
        sa.vy *= 0.7;
        for (const b of nodes) {
          if (a === b) continue;
          const sb = sim.get(b.page_id)!;
          const dx = sa.x - sb.x;
          const dy = sa.y - sb.y;
          const d2 = dx * dx + dy * dy + 1;
          const f = charge / d2;
          sa.vx -= (dx * f) / Math.sqrt(d2);
          sa.vy -= (dy * f) / Math.sqrt(d2);
        }
      }
      // attractive (links)
      for (const e of edges) {
        const sa = sim.get(e.source);
        const sb = sim.get(e.target);
        if (!sa || !sb) continue;
        const dx = sb.x - sa.x;
        const dy = sb.y - sa.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const k = (dist - linkDist) * 0.04 * (e.weight ?? 0.5);
        sa.vx += (dx / dist) * k;
        sa.vy += (dy / dist) * k;
        sb.vx -= (dx / dist) * k;
        sb.vy -= (dy / dist) * k;
      }
      // gravity to center
      for (const n of nodes) {
        const s = sim.get(n.page_id)!;
        s.vx += (W / 2 - s.x) * 0.005;
        s.vy += (H / 2 - s.y) * 0.005;
      }
      // integrate
      for (const n of nodes) {
        const s = sim.get(n.page_id)!;
        s.x += Math.max(-15, Math.min(15, s.vx));
        s.y += Math.max(-15, Math.min(15, s.vy));
        s.x = Math.max(20, Math.min(W - 20, s.x));
        s.y = Math.max(20, Math.min(H - 20, s.y));
      }
      force((f) => f + 1);
      if (iter < 200) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [nodes, edges]);

  if (loading) return <div className="loading">graph loading…</div>;

  const maxPr = Math.max(...nodes.map((n) => n.pagerank ?? 0), 0.01);

  return (
    <div className="graph-wrap">
      <svg ref={svgRef} viewBox="0 0 1200 700" preserveAspectRatio="xMidYMid meet">
        {edges.map((e, i) => {
          const sa = simRef.current.get(e.source);
          const sb = simRef.current.get(e.target);
          if (!sa || !sb) return null;
          return (
            <line
              key={i}
              x1={sa.x}
              y1={sa.y}
              x2={sb.x}
              y2={sb.y}
              stroke={EDGE_COLOR[e.link_type] ?? '#aaa'}
              strokeWidth={e.link_type === 'axis_cross' ? 0.5 : 1}
              strokeOpacity={0.3}
            />
          );
        })}
        {nodes.map((n) => {
          const s = simRef.current.get(n.page_id);
          if (!s) return null;
          const r = 4 + Math.sqrt(((n.pagerank ?? 0) / maxPr) * 100) * 1.5;
          const color = BUCKET_COLOR[bucketAxis(n.bucket)] ?? '#888';
          return (
            <g key={n.page_id}>
              <circle
                cx={s.x}
                cy={s.y}
                r={r}
                fill={color}
                stroke="#fff"
                strokeWidth={0.5}
                onMouseEnter={() => setHover(n)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              />
              {r >= 8 && (
                <text
                  x={s.x}
                  y={s.y - r - 2}
                  fontSize={9}
                  textAnchor="middle"
                  fill="#333"
                  pointerEvents="none"
                >
                  {(n.title_hint ?? n.page_id).slice(0, 14)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            padding: '6px 10px',
            fontSize: 11,
            borderRadius: 4,
            maxWidth: 280,
          }}
        >
          <div style={{ fontWeight: 600 }}>{hover.title_hint}</div>
          <div>{hover.bucket} · {hover.intent_layer ?? '-'}</div>
          <div>PR {hover.pagerank?.toFixed(4) ?? '-'} · cover {hover.cover_size}</div>
        </div>
      )}
      <div className="legend">
        <div style={{ marginBottom: 4, fontWeight: 600 }}>edges</div>
        <div style={{ color: '#1565c0' }}>━ structural (L4 親)</div>
        <div style={{ color: '#2e7d32' }}>━ contextual (cosine)</div>
        <div style={{ color: '#bbb' }}>━ axis_cross (→ROOT)</div>
        <div style={{ marginTop: 6, fontWeight: 600 }}>nodes (color=axis)</div>
        {Object.entries(BUCKET_COLOR).map(([k, v]) => (
          <div key={k} style={{ color: v }}>● {k}</div>
        ))}
      </div>
    </div>
  );
}
