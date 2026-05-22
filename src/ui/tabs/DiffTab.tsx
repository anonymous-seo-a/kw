import React, { useEffect, useMemo, useState } from 'react';

interface Row {
  candidate_id: number;
  keyword: string;
  cluster_id: string | null;
  page_id: string | null;
  page_rep: string | null;
  bucket: string | null;
  intent_layer: string | null;
  action: string | null;
  volume: number | null;
  kd: number | null;
  cpc: number | null;
  intent: string | null;
  sources: Array<{ provider: string; meta?: Record<string, unknown> }>;
}

export function DiffTab({ runId }: { runId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [bucket, setBucket] = useState('');
  const [intent, setIntent] = useState('');
  const [page, setPage] = useState('');
  const [provider, setProvider] = useState('');

  useEffect(() => {
    setLoading(true);
    fetch(`/api/dashboard/${runId}/diff?limit=10000`)
      .then((r) => r.json())
      .then((d: { rows: Row[]; total: number }) => {
        setRows(d.rows);
        setTotal(d.total);
        setLoading(false);
      });
  }, [runId]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (q && !r.keyword.toLowerCase().includes(q.toLowerCase())) return false;
      if (bucket && r.bucket !== bucket) return false;
      if (intent && r.intent_layer !== intent) return false;
      if (page && r.page_id !== page) return false;
      if (provider && !r.sources.some((s) => s.provider === provider)) return false;
      return true;
    });
  }, [rows, q, bucket, intent, page, provider]);

  const buckets = useMemo(
    () =>
      [...new Set(rows.map((r) => r.bucket).filter((x): x is string => !!x))].sort(),
    [rows],
  );
  const pages = useMemo(
    () => [...new Set(rows.map((r) => r.page_id).filter((x): x is string => !!x))].sort(),
    [rows],
  );
  const providers = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) for (const x of r.sources) s.add(x.provider);
    return [...s].sort();
  }, [rows]);

  if (loading) return <div className="loading">DIFF表 loading…</div>;

  return (
    <div>
      <div className="filters">
        <input
          placeholder="KW検索"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 200 }}
        />
        <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
          <option value="">all buckets</option>
          {buckets.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <select value={intent} onChange={(e) => setIntent(e.target.value)}>
          <option value="">all intents</option>
          <option value="manifest">manifest (顕在)</option>
          <option value="latent">latent (潜在)</option>
          <option value="reassurance">reassurance (安心)</option>
        </select>
        <select value={page} onChange={(e) => setPage(e.target.value)}>
          <option value="">all pages</option>
          {pages.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">all providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <div className="count">
          {filtered.length} / {total} 件
        </div>
      </div>

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 50 }}>id</th>
              <th>キーワード</th>
              <th>page</th>
              <th>bucket</th>
              <th>intent</th>
              <th>vol</th>
              <th>KD</th>
              <th>CPC</th>
              <th>action</th>
              <th>source</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 5000).map((r) => (
              <tr key={r.candidate_id}>
                <td className="mono dim">{r.candidate_id}</td>
                <td>{r.keyword}</td>
                <td className="mono">
                  {r.page_id ?? <span className="dim">—</span>}
                  {r.page_rep && <div className="dim" style={{ fontSize: 10 }}>{r.page_rep}</div>}
                </td>
                <td>{r.bucket && <span className="badge badge-bucket">{r.bucket}</span>}</td>
                <td>
                  {r.intent_layer && (
                    <span className={`badge badge-intent-${r.intent_layer}`}>{r.intent_layer}</span>
                  )}
                </td>
                <td className="mono">{r.volume ?? <span className="dim">—</span>}</td>
                <td className="mono">{r.kd ?? <span className="dim">—</span>}</td>
                <td className="mono">{r.cpc ?? <span className="dim">—</span>}</td>
                <td>
                  {r.action && <span className={`badge badge-action-${r.action}`}>{r.action}</span>}
                </td>
                <td className="mono dim" style={{ fontSize: 10 }}>
                  {r.sources.map((s) => s.provider).join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
