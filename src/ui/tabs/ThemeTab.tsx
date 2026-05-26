import React, { useEffect, useMemo, useState } from 'react';

interface Theme {
  theme_id: string;
  theme_name: string;
  rationale: string | null;
  page_count: number;
}
interface PageRow {
  page_id: string;
  theme_id: string;
  theme_name: string;
  page_rep_kw: string;
  bucket: string;
  parent_location: string;
  intent_layer: string;
  page_cover_size: number;
  pagerank: number | null;
  rep_volume: number | null;
  action: string;
  member_count: number;
}

interface Member {
  keyword: string;
  is_representative: number;
  volume: number | null;
  kd: number | null;
  cpc: number | null;
  intent: string | null;
}

export function ThemeTab({ runId }: { runId: string }) {
  const [themes, setThemes] = useState<Theme[]>([]);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedThemes, setExpandedThemes] = useState<Set<string>>(new Set());
  const [expandedPages, setExpandedPages] = useState<Set<string>>(new Set());
  const [pageMembers, setPageMembers] = useState<Record<string, Member[]>>({});
  const [q, setQ] = useState('');

  useEffect(() => {
    setLoading(true);
    fetch(`/api/dashboard/${runId}/themes`)
      .then((r) => r.json())
      .then((d: { themes: Theme[]; pages: PageRow[] }) => {
        setThemes(d.themes);
        setPages(d.pages);
        setExpandedThemes(new Set(d.themes.map((t) => t.theme_id)));
        setLoading(false);
      });
  }, [runId]);

  const pagesByTheme = useMemo(() => {
    const m = new Map<string, PageRow[]>();
    for (const p of pages) {
      const k = p.theme_id || '(theme未割当)';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    }
    // page sort within theme: pagerank desc → cover desc
    for (const arr of m.values()) {
      arr.sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0) || b.page_cover_size - a.page_cover_size);
    }
    return m;
  }, [pages]);

  function toggleTheme(t: string) {
    const next = new Set(expandedThemes);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setExpandedThemes(next);
  }
  function togglePage(pid: string) {
    const next = new Set(expandedPages);
    if (next.has(pid)) {
      next.delete(pid);
    } else {
      next.add(pid);
      if (!pageMembers[pid]) {
        // fetch page detail (members)
        fetch(`/api/dashboard/${runId}/page/${pid}`)
          .then((r) => r.json())
          .then((d: { members: Member[] }) => {
            setPageMembers((prev) => ({ ...prev, [pid]: d.members }));
          });
      }
    }
    setExpandedPages(next);
  }

  if (loading) return <div className="loading">テーマ別 loading…</div>;

  const filteredThemes = themes.filter((t) => {
    if (!q) return true;
    const ql = q.toLowerCase();
    if (t.theme_name.toLowerCase().includes(ql)) return true;
    const ps = pagesByTheme.get(t.theme_id) ?? [];
    return ps.some(
      (p) =>
        p.page_rep_kw.toLowerCase().includes(ql) ||
        p.bucket.toLowerCase().includes(ql) ||
        p.parent_location.toLowerCase().includes(ql),
    );
  });

  return (
    <div>
      <div className="filters" style={{ marginBottom: 8 }}>
        <input
          placeholder="theme・page rep・bucket で検索"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 320 }}
        />
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
          ⬇ CSV (1行=1page)
        </a>
        <div className="count">
          {themes.length} themes · {pages.length} pages
        </div>
      </div>

      <div className="scroll" style={{ height: 'calc(100vh - 180px)', padding: '0.5rem' }}>
        {filteredThemes.map((t) => {
          const isExp = expandedThemes.has(t.theme_id);
          const ps = pagesByTheme.get(t.theme_id) ?? [];
          return (
            <div key={t.theme_id} style={themeBlock}>
              <div style={themeHeader} onClick={() => toggleTheme(t.theme_id)}>
                <span style={{ width: 18, fontSize: 14 }}>{isExp ? '▼' : '▶'}</span>
                <span style={{ fontSize: 16, fontWeight: 700 }}>
                  【{t.theme_id}】 {t.theme_name}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: '#666' }}>
                  {ps.length} page · cover {ps.reduce((s, p) => s + p.page_cover_size, 0)}
                </span>
              </div>
              {t.rationale && (
                <div style={{ padding: '4px 32px', fontSize: 11, color: '#888' }}>
                  {t.rationale}
                </div>
              )}
              {isExp && (
                <div>
                  {ps.map((p) => {
                    const pExp = expandedPages.has(p.page_id);
                    return (
                      <div key={p.page_id} style={pageRow}>
                        <div style={pageHeader} onClick={() => togglePage(p.page_id)}>
                          <span style={{ width: 16, fontSize: 12 }}>{pExp ? '▼' : '▶'}</span>
                          <span style={{ fontSize: 12, fontWeight: 600 }}>
                            {p.bucket.startsWith('location:') && p.parent_location && (
                              <span style={{ color: '#1565c0', fontWeight: 500 }}>
                                {p.parent_location} ›{' '}
                              </span>
                            )}
                            {p.page_rep_kw}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              color: '#666',
                              marginLeft: 8,
                            }}
                          >
                            {p.bucket} · cover {p.page_cover_size} · rep_vol{' '}
                            {p.rep_volume ?? '—'}
                            {p.pagerank ? ` · PR ${p.pagerank.toFixed(3)}` : ''}
                            {p.intent_layer && (
                              <span className={`badge badge-intent-${p.intent_layer}`} style={{ marginLeft: 6 }}>
                                {p.intent_layer}
                              </span>
                            )}
                          </span>
                          <span style={{ marginLeft: 'auto', fontSize: 10, color: '#aaa' }}>
                            {p.member_count} KW · {p.page_id}
                          </span>
                        </div>
                        {pExp && (
                          <div style={{ padding: '4px 32px' }}>
                            {!pageMembers[p.page_id] ? (
                              <div style={{ color: '#888', fontSize: 11 }}>loading…</div>
                            ) : (
                              <table style={{ fontSize: 11 }}>
                                <thead>
                                  <tr>
                                    <th style={{ width: 24 }}></th>
                                    <th>member_kw</th>
                                    <th style={{ width: 70 }}>vol</th>
                                    <th style={{ width: 50 }}>KD</th>
                                    <th style={{ width: 60 }}>CPC</th>
                                    <th style={{ width: 90 }}>intent</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {pageMembers[p.page_id]!.map((m, i) => (
                                    <tr key={i}>
                                      <td>{m.is_representative ? '★' : ''}</td>
                                      <td>{m.keyword}</td>
                                      <td className="mono">{m.volume ?? '—'}</td>
                                      <td className="mono">{m.kd ?? '—'}</td>
                                      <td className="mono">{m.cpc ?? '—'}</td>
                                      <td className="mono dim">{m.intent ?? ''}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const themeBlock: React.CSSProperties = {
  marginBottom: 6,
  border: '1px solid #ccc',
  background: '#fff',
  borderRadius: 4,
};
const themeHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0.6rem 0.7rem',
  cursor: 'pointer',
  background: '#1a1a2e',
  color: '#fff',
  borderRadius: '4px 4px 0 0',
};
const pageRow: React.CSSProperties = {
  borderTop: '1px solid #eee',
};
const pageHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '0.45rem 0.7rem',
  cursor: 'pointer',
  background: '#f7f7fa',
};
