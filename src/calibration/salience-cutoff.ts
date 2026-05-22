/**
 * 校正: graphホップ / salience cutoff
 *
 * 仕様§4: 「Nホップ先のエンティティが上位記事に出現する割合の変曲点」
 *
 * パイロット実装:
 *   - l1_entities (seed/fanout からGoogle NLPで取得済) + l2_entities (各候補KWのentity) を母集団とする
 *   - SERPトップ10タイトル/snippet に出現するか (=「上位記事に出現」のproxy) を判定
 *   - salience cutoff を [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2] で振り、出現率 (precision-like) を出す
 *   - 出現率の変曲点 (二階差分) を提示
 *
 * NLP creds 無しなら l2_entities が空になる。その場合 l1_entities のみで集計し、
 * skipReasonを evidence に含める。
 */
import { kwDb, serpCacheDb } from '../lib/db.js';

export interface SalienceEvidence {
  cutoffs: number[];
  /** 各cutoffで salience ≥ cutoff のエンティティ数 */
  entityCountAtOrAbove: number[];
  /** 各cutoffで「上位SERP記事(タイトル/snippet)に出現したエンティティ数」 */
  appearedInTopSerp: number[];
  /** appearedInTopSerp / entityCountAtOrAbove */
  appearanceRate: number[];
  /** 一階差分 (slope) */
  firstDiff: number[];
  /** 二階差分 (curvature) — 変曲点検出用 */
  secondDiff: number[];
  /** 候補エンティティ総数 */
  totalEntities: number;
  /** SERP テキスト総量(参考) */
  serpTextBytes: number;
  notes: string[];
}

interface EntityRow {
  name: string;
  salience: number;
  mid: string | null;
}

function loadEntities(runId: string): EntityRow[] {
  const db = kwDb();
  const fromL1 = db
    .prepare(
      `SELECT name, salience, mid FROM l1_entities WHERE run_id=? AND salience IS NOT NULL`,
    )
    .all(runId) as Array<{ name: string; salience: number; mid: string | null }>;
  const fromL2 = db
    .prepare(
      `SELECT le.name, le.salience, le.mid
       FROM l2_entities le
       JOIN l1_candidates lc ON lc.id = le.candidate_id
       WHERE lc.run_id=?`,
    )
    .all(runId) as Array<{ name: string; salience: number; mid: string | null }>;

  // dedupe by (name,mid). max salience wins.
  const map = new Map<string, EntityRow>();
  for (const r of [...fromL1, ...fromL2]) {
    const key = `${r.mid ?? ''}|${r.name}`;
    const existing = map.get(key);
    if (!existing || (r.salience ?? 0) > existing.salience) {
      map.set(key, { name: r.name, salience: r.salience ?? 0, mid: r.mid });
    }
  }
  return [...map.values()];
}

function loadSerpTextCorpus(runId: string): string {
  // 全L2 SERP fingerprints の cache_key を集め、serp_resultsから result_json の
  // organic_results の title + snippet を抜く。
  const refs = kwDb()
    .prepare(
      `SELECT lf.cache_key FROM l2_serp_fp lf
       JOIN l1_candidates lc ON lc.id = lf.candidate_id
       WHERE lc.run_id=?`,
    )
    .all(runId) as Array<{ cache_key: string }>;
  if (refs.length === 0) return '';

  const stmt = serpCacheDb().prepare(
    'SELECT result_json FROM serp_results WHERE cache_key=?',
  );
  const parts: string[] = [];
  for (const r of refs) {
    const row = stmt.get(r.cache_key) as { result_json: string } | undefined;
    if (!row) continue;
    try {
      const j = JSON.parse(row.result_json) as {
        organic_results?: Array<{ title?: string; snippet?: string }>;
        related_questions?: Array<{ question?: string; snippet?: string }>;
      };
      for (const o of j.organic_results ?? []) {
        if (o.title) parts.push(o.title);
        if (o.snippet) parts.push(o.snippet);
      }
      for (const q of j.related_questions ?? []) {
        if (q.question) parts.push(q.question);
        if (q.snippet) parts.push(q.snippet);
      }
    } catch {
      /* noop */
    }
  }
  return parts.join('\n');
}

export function buildSalienceCutoffEvidence(runId: string): SalienceEvidence {
  const entities = loadEntities(runId);
  const corpus = loadSerpTextCorpus(runId);
  const corpusLower = corpus.toLowerCase();

  const cutoffs = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2];
  const entityCountAtOrAbove: number[] = [];
  const appearedInTopSerp: number[] = [];
  const appearanceRate: number[] = [];

  for (const cut of cutoffs) {
    const subset = entities.filter((e) => e.salience >= cut);
    let appeared = 0;
    for (const e of subset) {
      // 大文字小文字非依存 + 完全部分一致 (短すぎる名は除外)
      const name = e.name.toLowerCase();
      if (name.length < 2) continue;
      if (corpusLower.includes(name)) appeared++;
    }
    entityCountAtOrAbove.push(subset.length);
    appearedInTopSerp.push(appeared);
    appearanceRate.push(subset.length === 0 ? 0 : appeared / subset.length);
  }

  // 一階・二階差分
  const firstDiff: number[] = [];
  for (let i = 1; i < appearanceRate.length; i++) {
    firstDiff.push(appearanceRate[i]! - appearanceRate[i - 1]!);
  }
  const secondDiff: number[] = [];
  for (let i = 1; i < firstDiff.length; i++) {
    secondDiff.push(firstDiff[i]! - firstDiff[i - 1]!);
  }

  const notes: string[] = [];
  if (entities.length === 0) notes.push('no entities (NLP skipped or empty)');
  if (corpus.length === 0) notes.push('no SERP corpus');

  return {
    cutoffs,
    entityCountAtOrAbove,
    appearedInTopSerp,
    appearanceRate,
    firstDiff,
    secondDiff,
    totalEntities: entities.length,
    serpTextBytes: corpus.length,
    notes,
  };
}

export function suggestSalienceCandidates(
  ev: SalienceEvidence,
): Array<{ value: number; rationale: string }> {
  // 変曲点 (二階差分の絶対値最大)
  const out: Array<{ value: number; rationale: string }> = [];
  if (ev.secondDiff.length > 0) {
    let maxAbs = -1;
    let maxIdx = 0;
    for (let i = 0; i < ev.secondDiff.length; i++) {
      const abs = Math.abs(ev.secondDiff[i]!);
      if (abs > maxAbs) {
        maxAbs = abs;
        maxIdx = i;
      }
    }
    // secondDiff[i] corresponds to cutoffs[i+2] (二段先送り)
    const cIdx = maxIdx + 2;
    const value = ev.cutoffs[cIdx] ?? ev.cutoffs[ev.cutoffs.length - 1]!;
    out.push({
      value,
      rationale: `inflection at cutoff=${value} (2nd-diff peak=${ev.secondDiff[maxIdx]?.toFixed(4)}, rate=${ev.appearanceRate[cIdx]?.toFixed(3)})`,
    });
  }
  // 仕様の仮値 0.01
  if (!out.find((c) => Math.abs(c.value - 0.01) < 1e-9)) {
    const idx = ev.cutoffs.indexOf(0.01);
    out.push({
      value: 0.01,
      rationale: idx >= 0
        ? `spec default 0.01 (rate=${ev.appearanceRate[idx]?.toFixed(3)}, |≥|=${ev.entityCountAtOrAbove[idx]})`
        : `spec default 0.01`,
    });
  }
  // 最も rate が高い cutoff
  let bestRateIdx = 0;
  for (let i = 1; i < ev.appearanceRate.length; i++) {
    if ((ev.appearanceRate[i] ?? 0) > (ev.appearanceRate[bestRateIdx] ?? 0)) bestRateIdx = i;
  }
  const bestRateValue = ev.cutoffs[bestRateIdx]!;
  if (!out.find((c) => Math.abs(c.value - bestRateValue) < 1e-9)) {
    out.push({
      value: bestRateValue,
      rationale: `max appearance rate=${ev.appearanceRate[bestRateIdx]?.toFixed(3)} (|≥|=${ev.entityCountAtOrAbove[bestRateIdx]})`,
    });
  }
  return out.sort((a, b) => a.value - b.value);
}
