import React, { useEffect, useMemo, useState } from 'react';

interface Member {
  keyword: string;
  is_representative: number;
  volume: number | null;
  kd: number | null;
  cpc: number | null;
  intent: string | null;
}

interface Group {
  page_id: string;
  axis_kw: string;
  bucket: string;
  intent_layer: string;
  pagerank: number | null;
  page_cover_size: number;
  members: Member[];
}

export function OutputTab({ runId }: { runId: string }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showUnassigned, setShowUnassigned] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/dashboard/${runId}/page-members`)
      .then((r) => r.json())
      .then((d: { groups: Group[] }) => {
        setGroups(d.groups);
        // 全グループ初期展開
        setExpanded(new Set(d.groups.map((g) => g.page_id)));
        setLoading(false);
      });
  }, [runId]);

  const filtered = useMemo(() => {
    return groups.filter((g) => {
      if (!showUnassigned && g.page_id === '(unassigned)') return false;
      if (!q) return true;
      const ql = q.toLowerCase();
      if (
        g.axis_kw.toLowerCase().includes(ql) ||
        g.bucket.toLowerCase().includes(ql) ||
        g.members.some((m) => m.keyword.toLowerCase().includes(ql))
      ) {
        return true;
      }
      return false;
    });
  }, [groups, q, showUnassigned]);

  const totals = useMemo(() => {
    const pages = groups.filter((g) => g.page_id !== '(unassigned)').length;
    const totalKws = groups.reduce((s, g) => s + g.members.length, 0);
    const totalVol = groups.reduce(
      (s, g) => s + g.members.reduce((ss, m) => ss + (m.volume ?? 0), 0),
      0,
    );
    return { pages, totalKws, totalVol };
  }, [groups]);

  function toggle(pid: string) {
    const next = new Set(expanded);
    if (next.has(pid)) next.delete(pid);
    else next.add(pid);
    setExpanded(next);
  }

  function expandAll() {
    setExpanded(new Set(filtered.map((g) => g.page_id)));
  }
  function collapseAll() {
    setExpanded(new Set());
  }

  if (loading) return <div className="loading">出力 loading…</div>;

  return (
    <div>
      <div className="filters" style={{ marginBottom: 8 }}>
        <input
          placeholder="軸KW・バケット・配下KW で検索"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 300 }}
        />
        <button onClick={expandAll} style={btn}>全展開</button>
        <button onClick={collapseAll} style={btn}>全折りたたみ</button>
        <label style={{ fontSize: 11, color: '#666', marginLeft: 8 }}>
          <input
            type="checkbox"
            checked={showUnassigned}
            onChange={(e) => setShowUnassigned(e.target.checked)}
            style={{ marginRight: 4 }}
          />
          未割当KWも表示
        </label>
        <a
          href={`/api/dashboard/${runId}/csv`}
          download
          style={{
            marginLeft: 'auto',
            padding: '5px 12px',
            background: '#1a1a2e',
            color: '#fff',
            textDecoration: 'none',
            borderRadius: 3,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          ⬇ CSV ダウンロード
        </a>
        <div className="count">
          {totals.pages} pages · {totals.totalKws} KW · 累計vol {totals.totalVol.toLocaleString()}
        </div>
      </div>

      <div className="scroll" style={{ height: 'calc(100vh - 180px)', padding: '0.5rem' }}>
        {filtered.map((g) => {
          const isExpanded = expanded.has(g.page_id);
          const grVol = g.members.reduce((s, m) => s + (m.volume ?? 0), 0);
          return (
            <div key={g.page_id} style={pageBlock}>
              <div style={pageHeader} onClick={() => toggle(g.page_id)}>
                <span style={{ width: 18, fontSize: 14 }}>{isExpanded ? '▼' : '▶'}</span>
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  【{g.bucket || '—'}】 {g.axis_kw}
                </span>
                <span className={`badge badge-intent-${g.intent_layer || 'manifest'}`} style={{ marginLeft: 6 }}>
                  {g.intent_layer || '—'}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: '#666' }}>
                  {g.members.length} KW · vol合計 {grVol.toLocaleString()}
                  {g.pagerank ? ` · PR ${g.pagerank.toFixed(3)}` : ''} ·{' '}
                  <span className="mono dim">{g.page_id}</span>
                </span>
              </div>
              {isExpanded && (
                <table style={{ marginTop: 0 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}></th>
                      <th>配下記事KW</th>
                      <th style={{ width: 80 }}>volume</th>
                      <th style={{ width: 60 }}>KD</th>
                      <th style={{ width: 60 }}>CPC</th>
                      <th style={{ width: 120 }}>intent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.members.map((m, i) => (
                      <tr key={i}>
                        <td>{m.is_representative ? '★' : ''}</td>
                        <td>{m.keyword}</td>
                        <td className="mono">{m.volume ?? <span className="dim">—</span>}</td>
                        <td className="mono">{m.kd ?? <span className="dim">—</span>}</td>
                        <td className="mono">{m.cpc ?? <span className="dim">—</span>}</td>
                        <td className="mono dim" style={{ fontSize: 10 }}>
                          {m.intent ?? ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 11,
  border: '1px solid #ccc',
  background: '#fff',
  borderRadius: 3,
  cursor: 'pointer',
};

const pageBlock: React.CSSProperties = {
  marginBottom: 4,
  border: '1px solid #ddd',
  background: '#fff',
  borderRadius: 3,
};

const pageHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0.55rem 0.7rem',
  cursor: 'pointer',
  background: '#f7f7fa',
  borderBottom: '1px solid #eee',
};
