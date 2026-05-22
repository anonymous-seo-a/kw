/**
 * 校正: 密度ギャップ (seed centroidからの cosine距離で「領域の縁」を切る点)
 *
 * 仕様§4: 「seed centroidからの距離ヒストグラムの谷」
 *
 * 実装:
 *   - 全候補のseedとのcosineを算出 (1 - cosine = 距離)
 *   - ヒストグラム (20bins) + smoothing
 *   - 局所最小 (谷) を検出 → 候補値
 */
import { cosine } from '../lib/voyage.js';
import { loadRunVectors, centroid } from '../lib/embeddings.js';

export interface DensityGapEvidence {
  seedKw: string;
  totalCandidates: number;
  withVectors: number;
  /** cosine to seed の分布 (低い=遠い) */
  cosineHistogram: { bins: number[]; counts: number[] };
  /** smoothed counts (window=3 moving avg) */
  smoothedCounts: number[];
  /** 検出された谷 (bin中央値) */
  valleys: Array<{ binIndex: number; cosineCenter: number; count: number }>;
  /** 統計値 */
  stats: { min: number; max: number; mean: number; median: number; p10: number; p90: number };
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx]!;
}

export function buildDensityGapEvidence(runId: string, seedKw: string): DensityGapEvidence {
  const vectors = loadRunVectors(runId);

  // seed のベクトル: seed自身もl1_candidatesに入っていない場合があるので、
  // 候補全体の centroid を seed候補centroidの近似として使う (パイロット seed=AGAおすすめ は
  // 全候補が領域内なので中心への代理)。または l1_candidates に seedが入っていればそれを使う。
  const seedVec = vectors.find((v) => v.keyword === seedKw)?.vector ?? centroid(vectors.map((v) => v.vector));

  const cosines = vectors.map((v) => cosine(seedVec, v.vector));
  const sorted = [...cosines].sort((a, b) => a - b);

  // ヒストグラム: cosineは [-1,1] だが実用域は [0,1]、binsは [0.2, 1.0]
  const binCount = 20;
  const lo = 0.2;
  const hi = 1.0;
  const counts = new Array(binCount).fill(0);
  const bins = Array.from({ length: binCount + 1 }, (_, i) => lo + (i * (hi - lo)) / binCount);
  for (const c of cosines) {
    if (c < lo) {
      counts[0]!++;
      continue;
    }
    if (c >= hi) {
      counts[binCount - 1]!++;
      continue;
    }
    const idx = Math.min(binCount - 1, Math.floor(((c - lo) / (hi - lo)) * binCount));
    counts[idx]++;
  }

  // 平滑化 (window=3)
  const smoothed = counts.map((_, i) => {
    const a = counts[Math.max(0, i - 1)]!;
    const b = counts[i]!;
    const c = counts[Math.min(binCount - 1, i + 1)]!;
    return (a + b + c) / 3;
  });

  // 谷検出: 局所最小 = i-1 > i < i+1
  const valleys: DensityGapEvidence['valleys'] = [];
  for (let i = 1; i < binCount - 1; i++) {
    if (smoothed[i]! < smoothed[i - 1]! && smoothed[i]! < smoothed[i + 1]!) {
      valleys.push({
        binIndex: i,
        cosineCenter: (bins[i]! + bins[i + 1]!) / 2,
        count: counts[i]!,
      });
    }
  }
  // モード間の最深谷を優先
  valleys.sort((a, b) => a.count - b.count);

  return {
    seedKw,
    totalCandidates: vectors.length,
    withVectors: vectors.length,
    cosineHistogram: { bins, counts },
    smoothedCounts: smoothed,
    valleys,
    stats: {
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      mean: cosines.length === 0 ? 0 : cosines.reduce((s, x) => s + x, 0) / cosines.length,
      median: median(sorted),
      p10: percentile(sorted, 0.1),
      p90: percentile(sorted, 0.9),
    },
  };
}

export function suggestDensityGapCandidates(
  ev: DensityGapEvidence,
): Array<{ value: number; rationale: string }> {
  const out: Array<{ value: number; rationale: string }> = [];
  for (const v of ev.valleys.slice(0, 3)) {
    out.push({
      value: Number(v.cosineCenter.toFixed(3)),
      rationale: `valley@bin${v.binIndex} (count=${v.count})`,
    });
  }
  // 候補がゼロなら p10 を fallback
  if (out.length === 0) {
    out.push({
      value: Number(ev.stats.p10.toFixed(3)),
      rationale: `no valley detected; p10 fallback (median=${ev.stats.median.toFixed(3)}, p10=${ev.stats.p10.toFixed(3)})`,
    });
  }
  return out;
}
