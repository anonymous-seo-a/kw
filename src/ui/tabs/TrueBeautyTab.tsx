import React, { useEffect, useState } from 'react';

interface Check {
  kind: string;
  status: 'pass' | 'fail' | 'flag';
  metric: Record<string, unknown> | null;
  rationale: string;
}

const KIND_LABEL: Record<string, string> = {
  necessity: '必然性',
  closure: '閉合性',
  minimality: '最小性',
  boundary: '境界',
  compliance: 'コンプラ',
};

export function TrueBeautyTab({ runId }: { runId: string }) {
  const [checks, setChecks] = useState<Check[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/dashboard/${runId}/truebeauty`)
      .then((r) => r.json())
      .then((d: { checks: Check[] }) => {
        setChecks(d.checks);
        setLoading(false);
      });
  }, [runId]);

  if (loading) return <div className="loading">真=美 loading…</div>;

  return (
    <div className="tb-grid">
      {checks.map((c) => (
        <div key={c.kind} className="tb-card">
          <h3>
            {KIND_LABEL[c.kind] ?? c.kind}{' '}
            <span className={`badge badge-status-${c.status}`}>{c.status.toUpperCase()}</span>
          </h3>
          <div style={{ fontSize: 12, color: '#444', marginBottom: 6 }}>{c.rationale}</div>
          <pre>{JSON.stringify(c.metric, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}
