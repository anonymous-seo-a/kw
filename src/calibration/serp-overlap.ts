/**
 * 校正: SERP重複N (top10URL一致数の閾値)
 *
 * 仕様§4: 「seed周辺クエリペアのSERP一致率分布を見て、同一ページ運用が妥当な閾を決定」
 *   - 候補KW pair 全件について top10 URL の重複数を集計
 *   - 重複数の分布 + (重複数 ≥ N) のペア数の累積を出して knee を提示
 */
import { kwDb, serpCacheDb } from '../lib/db.js';

export interface PairOverlap {
  candidateIdA: number;
  candidateIdB: number;
  overlap: number;
}

export interface SerpOverlapEvidence {
  totalPairs: number;
  pairsWithSerpFp: number;
  /** overlap → ペア数 (0..10) */
  histogram: number[];
  /** N=1..10 で「overlap ≥ N」のペア数（累積） */
  atLeast: number[];
  /** 一致率分布: histogram[N]/totalPairs */
  ratio: number[];
}

function loadSerpFp(
  runId: string,
): Map<number, Set<string>> {
  const refs = kwDb()
    .prepare(
      `SELECT lf.candidate_id, lf.cache_key
       FROM l2_serp_fp lf
       JOIN l1_candidates lc ON lc.id = lf.candidate_id
       WHERE lc.run_id = ?`,
    )
    .all(runId) as Array<{ candidate_id: number; cache_key: string }>;

  const topUrlStmt = serpCacheDb().prepare(
    'SELECT url FROM serp_top_urls WHERE cache_key=? ORDER BY rank LIMIT 10',
  );

  const map = new Map<number, Set<string>>();
  for (const r of refs) {
    const rows = topUrlStmt.all(r.cache_key) as Array<{ url: string }>;
    if (rows.length === 0) continue;
    map.set(r.candidate_id, new Set(rows.map((x) => x.url)));
  }
  return map;
}

export function buildSerpOverlapEvidence(runId: string): {
  evidence: SerpOverlapEvidence;
  pairs: PairOverlap[];
} {
  const urlSets = loadSerpFp(runId);
  const ids = [...urlSets.keys()].sort((a, b) => a - b);
  const pairs: PairOverlap[] = [];
  const hist = new Array(11).fill(0);

  for (let i = 0; i < ids.length; i++) {
    const setA = urlSets.get(ids[i]!)!;
    for (let j = i + 1; j < ids.length; j++) {
      const setB = urlSets.get(ids[j]!)!;
      let inter = 0;
      for (const u of setA) if (setB.has(u)) inter++;
      hist[Math.min(inter, 10)]++;
      pairs.push({ candidateIdA: ids[i]!, candidateIdB: ids[j]!, overlap: inter });
    }
  }

  const totalPairs = pairs.length;
  const atLeast = new Array(11).fill(0);
  for (let n = 10; n >= 0; n--) {
    atLeast[n] = (atLeast[n + 1] ?? 0) + hist[n]!;
  }
  const ratio = hist.map((c) => (totalPairs === 0 ? 0 : c / totalPairs));

  return {
    evidence: {
      totalPairs,
      pairsWithSerpFp: ids.length,
      histogram: hist,
      atLeast,
      ratio,
    },
    pairs,
  };
}

/**
 * Knee 検出: atLeast[N] が急減する境界 (一階差分の最大)。
 * 仕様の仮値 3 を含む候補配列を返す。
 */
export function suggestSerpOverlapCandidates(
  ev: SerpOverlapEvidence,
): Array<{ value: number; rationale: string }> {
  const diffs: Array<{ n: number; drop: number }> = [];
  for (let n = 1; n <= 9; n++) {
    diffs.push({ n, drop: (ev.atLeast[n] ?? 0) - (ev.atLeast[n + 1] ?? 0) });
  }
  diffs.sort((a, b) => b.drop - a.drop);
  const top = diffs.slice(0, 3).sort((a, b) => a.n - b.n);

  const candidates = top.map((d) => ({
    value: d.n,
    rationale: `N=${d.n}: drop=${d.drop} pairs (|≥${d.n}|=${ev.atLeast[d.n]}, |≥${d.n + 1}|=${ev.atLeast[d.n + 1]})`,
  }));
  // 仕様の仮値 3 を必ず含める
  if (!candidates.find((c) => c.value === 3)) {
    candidates.push({
      value: 3,
      rationale: `spec default (Koray法 N≥3, |≥3|=${ev.atLeast[3]}/${ev.totalPairs})`,
    });
  }
  return candidates.sort((a, b) => a.value - b.value);
}
