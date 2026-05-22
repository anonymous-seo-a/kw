import React, { useEffect, useState } from 'react';
import { DiffTab } from './tabs/DiffTab.js';
import { TopicalTab } from './tabs/TopicalTab.js';
import { GraphTab } from './tabs/GraphTab.js';
import { ComplianceTab } from './tabs/ComplianceTab.js';
import { TrueBeautyTab } from './tabs/TrueBeautyTab.js';
import { PagesTab } from './tabs/PagesTab.js';

interface Run {
  run_id: string;
  seed_kw: string;
  vertical: string | null;
  status: string;
  created_at: number;
}

interface Counts {
  candidates: number;
  inRegion: number;
  inventory: number;
  clusters: number;
  pages: number;
  covered: number;
  uncovered: number;
}

type Tab = 'diff' | 'pages' | 'topical' | 'graph' | 'compliance' | 'truebeauty';

const TAB_LABELS: Record<Tab, string> = {
  diff: 'DIFF表',
  pages: 'ページ別KW',
  topical: 'topical map',
  graph: '内部リンク',
  compliance: 'コンプラ',
  truebeauty: '真=美',
};

export function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<string>('');
  const [counts, setCounts] = useState<Counts | null>(null);
  const [tab, setTab] = useState<Tab>('pages');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/runs')
      .then((r) => r.json())
      .then((d: { rows: Run[] }) => {
        // 直近の phase-done run を優先 (phase6_done > phase5_done > ...)
        const sorted = [...d.rows].sort((a, b) => {
          const rank = (s: string) =>
            s === 'phase6_done' ? 6 : s === 'phase5_done' ? 5 : s === 'phase4_done' ? 4 : s === 'l2_done' ? 2 : s === 'l1_done' ? 1 : 0;
          return rank(b.status) - rank(a.status) || b.created_at - a.created_at;
        });
        setRuns(sorted);
        if (sorted.length > 0 && !runId) setRunId(sorted[0]!.run_id);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!runId) return;
    setCounts(null);
    fetch(`/api/dashboard/${runId}/summary`)
      .then((r) => r.json())
      .then((d) => setCounts(d.counts))
      .catch((e) => setError(String(e)));
  }, [runId]);

  const currentRun = runs.find((r) => r.run_id === runId);

  return (
    <div className="app">
      <div className="topbar">
        <h1>Silo Coverage Designer</h1>
        <div className="runs">
          <span>run:</span>
          <select value={runId} onChange={(e) => setRunId(e.target.value)}>
            {runs.map((r) => (
              <option key={r.run_id} value={r.run_id}>
                {r.seed_kw} [{r.status}] — {r.run_id.slice(0, 16)}…
              </option>
            ))}
          </select>
        </div>
        {currentRun && (
          <div className="stats">
            <span>seed: <b>{currentRun.seed_kw}</b></span>
            <span>vertical: <b>{currentRun.vertical ?? 'none'}</b></span>
            {counts && (
              <>
                <span>cands <b>{counts.candidates}</b></span>
                <span>in-region <b>{counts.inRegion}</b></span>
                <span>clusters <b>{counts.clusters}</b></span>
                <span>pages <b>{counts.pages}</b></span>
                <span>
                  cov{' '}
                  <b>
                    {counts.covered + counts.uncovered === 0
                      ? '-'
                      : `${Math.round((counts.covered / (counts.covered + counts.uncovered)) * 100)}%`}
                  </b>
                </span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="tabs">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="content">
        {error && <div className="error">{error}</div>}
        {!runId ? (
          <div className="loading">runを選択してください</div>
        ) : tab === 'diff' ? (
          <DiffTab runId={runId} />
        ) : tab === 'pages' ? (
          <PagesTab runId={runId} />
        ) : tab === 'topical' ? (
          <TopicalTab runId={runId} />
        ) : tab === 'graph' ? (
          <GraphTab runId={runId} />
        ) : tab === 'compliance' ? (
          <ComplianceTab runId={runId} />
        ) : (
          <TrueBeautyTab runId={runId} />
        )}
      </div>
    </div>
  );
}
