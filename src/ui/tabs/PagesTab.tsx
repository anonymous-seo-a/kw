import React, { useEffect, useState } from 'react';

interface PageRow {
  page_id: string;
  title_hint: string | null;
  cover_size: number;
  pick_order: number;
  bucket: string | null;
  intent_layer: string | null;
  pagerank: number | null;
  diff_status: string | null;
}

interface Member {
  id: number;
  keyword: string;
  is_representative: number;
  volume: number | null;
  kd: number | null;
  cpc: number | null;
  intent: string | null;
}

interface PageDetail {
  page: PageRow & { cluster_id: string };
  members: Member[];
}

export function PagesTab({ runId }: { runId: string }) {
  const [pages, setPages] = useState<PageRow[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [detail, setDetail] = useState<PageDetail | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    fetch(`/api/dashboard/${runId}/pages`)
      .then((r) => r.json())
      .then((d: { rows: PageRow[] }) => {
        setPages(d.rows);
        if (d.rows.length > 0) setSelected(d.rows[0]!.page_id);
      });
  }, [runId]);

  useEffect(() => {
    if (!selected) return;
    setDetail(null);
    fetch(`/api/dashboard/${runId}/page/${selected}`)
      .then((r) => r.json())
      .then((d: PageDetail) => setDetail(d));
  }, [runId, selected]);

  const filtered = pages.filter((p) =>
    q
      ? (p.title_hint ?? '').toLowerCase().includes(q.toLowerCase()) ||
        (p.bucket ?? '').toLowerCase().includes(q.toLowerCase())
      : true,
  );

  return (
    <div className="pages-grid">
      <div className="pages-list">
        <div style={{ padding: '0.5rem', borderBottom: '1px solid #eee', background: '#fafafa' }}>
          <input
            placeholder="page検索"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: '100%', padding: '4px 8px', fontSize: 12 }}
          />
          <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>
            {filtered.length} / {pages.length} pages
          </div>
        </div>
        {filtered.map((p) => (
          <div
            key={p.page_id}
            className={`item ${selected === p.page_id ? 'active' : ''}`}
            onClick={() => setSelected(p.page_id)}
          >
            <div className="rep">
              {p.pick_order}. {p.title_hint}
            </div>
            <div className="meta">
              {p.bucket} · cover {p.cover_size}
              {p.pagerank ? ` · PR ${p.pagerank.toFixed(3)}` : ''}
              {p.intent_layer && (
                <>
                  {' '}
                  · <span className={`badge badge-intent-${p.intent_layer}`}>{p.intent_layer}</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="page-detail">
        {!detail ? (
          <div className="loading">page詳細 loading…</div>
        ) : (
          <>
            <h2>{detail.page.title_hint}</h2>
            <div className="meta-row">
              <span><b>{detail.page.page_id}</b></span>
              <span>bucket: <span className="badge badge-bucket">{detail.page.bucket}</span></span>
              {detail.page.intent_layer && (
                <span>
                  intent:{' '}
                  <span className={`badge badge-intent-${detail.page.intent_layer}`}>
                    {detail.page.intent_layer}
                  </span>
                </span>
              )}
              <span>cover: {detail.page.cover_size}</span>
              {detail.page.pagerank && <span>PR: {detail.page.pagerank.toFixed(4)}</span>}
              <span>members: {detail.members.length}</span>
              <span>total vol: {detail.members.reduce((s, m) => s + (m.volume ?? 0), 0).toLocaleString()}</span>
            </div>

            <table>
              <thead>
                <tr>
                  <th>rep</th>
                  <th>キーワード</th>
                  <th>volume</th>
                  <th>KD</th>
                  <th>CPC</th>
                  <th>intent</th>
                </tr>
              </thead>
              <tbody>
                {detail.members.map((m) => (
                  <tr key={m.id}>
                    <td>{m.is_representative ? '★' : ''}</td>
                    <td>{m.keyword}</td>
                    <td className="mono">{m.volume ?? <span className="dim">—</span>}</td>
                    <td className="mono">{m.kd ?? <span className="dim">—</span>}</td>
                    <td className="mono">{m.cpc ?? <span className="dim">—</span>}</td>
                    <td className="mono dim" style={{ fontSize: 10 }}>{m.intent ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
