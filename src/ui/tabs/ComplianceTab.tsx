import React, { useEffect, useState } from 'react';

interface Item {
  item_id: string;
  title: string;
  issuer: string | null;
  law_or_doc_name: string | null;
  article: string | null;
  source_url: string | null;
  related_urls_json: string | null;
  last_revised: string | null;
  severity: string;
  verification_needed: number;
  status: 'pending' | 'covered' | 'missing';
  covered_by_page_id: string | null;
  notes: string | null;
}

export function ComplianceTab({ runId }: { runId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/dashboard/${runId}/compliance`)
      .then((r) => r.json())
      .then((d: { items: Item[] }) => {
        setItems(d.items);
        setLoading(false);
      });
  }, [runId]);

  if (loading) return <div className="loading">コンプラ loading…</div>;
  if (items.length === 0) {
    return <div className="loading">vertical≠medical: コンプラ・フロア非適用</div>;
  }

  return (
    <div>
      <div style={{ marginBottom: 8, fontSize: 12, color: '#666' }}>
        {items.length} 必須要素 / 未充足{' '}
        <b style={{ color: '#c62828' }}>
          {items.filter((i) => i.status !== 'covered').length}
        </b>{' '}
        / 充足{' '}
        <b style={{ color: '#2e7d32' }}>
          {items.filter((i) => i.status === 'covered').length}
        </b>
        <br />
        最終可否はDaiki判断 (仕様§6: ツールはflag提示まで)
      </div>
      <div className="compliance-list">
        {items.map((it) => (
          <div key={it.item_id} className="item">
            <h3>
              {it.title}{' '}
              <span className={it.status === 'covered' ? 'status-covered' : 'status-missing'}>
                [{it.status}]
              </span>
              {it.verification_needed === 1 && (
                <span style={{ marginLeft: 6, color: '#f57f17', fontSize: 11 }}>
                  TODO:要確認
                </span>
              )}
            </h3>
            <div className="meta">
              {it.issuer && <>発行: {it.issuer}　</>}
              {it.law_or_doc_name && <>{it.law_or_doc_name}　</>}
              {it.article && <>{it.article}　</>}
              {it.last_revised && <>最終改正: {it.last_revised}</>}
            </div>
            {it.source_url && (
              <div>
                <a href={it.source_url} target="_blank" rel="noopener noreferrer">
                  {it.source_url}
                </a>
              </div>
            )}
            {it.related_urls_json && (() => {
              try {
                const urls = JSON.parse(it.related_urls_json) as string[];
                return (
                  <div style={{ fontSize: 10, marginTop: 3 }}>
                    関連:{' '}
                    {urls.map((u, i) => (
                      <a key={i} href={u} target="_blank" rel="noopener noreferrer" style={{ marginRight: 6 }}>
                        link{i + 1}
                      </a>
                    ))}
                  </div>
                );
              } catch {
                return null;
              }
            })()}
            {it.notes && (
              <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>{it.notes}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
