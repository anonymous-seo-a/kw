/**
 * 校正: cosine しきい値 (embedding距離で「同一クラスタ」と判定する下限)
 *
 * 仕様§4: 「同一/別クラスタの正解例を数十ペア手動ラベル → ROCで決定」
 *
 * パイロットでは人手ラベルがまだ存在しないため、SERP重複(≥3)を「同一クラスタ」
 * の proxy positive label として扱い、ROCを引く。これは仮値であり、Daikiが
 * 校正レポートで pair samplesを目視してから真のしきい値を決める前提。
 */
import { cosine } from '../lib/voyage.js';
import { loadRunVectors } from '../lib/embeddings.js';
import type { PairOverlap } from './serp-overlap.js';

export interface RocPoint {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  tpr: number;
  fpr: number;
  precision: number;
  f1: number;
}

export interface CosineEvidence {
  proxyLabel: string;        // どんな proxy で positive を定義したか
  pairsTotal: number;
  positives: number;
  negatives: number;
  /** cosine分布 (positive/negative別ヒストグラム, bins=20) */
  histogram: { bins: number[]; positiveCounts: number[]; negativeCounts: number[] };
  /** ROC: 21点 (0.0..1.0) */
  roc: RocPoint[];
  auc: number;
  /** F1最大点 */
  bestByF1: RocPoint;
  /** TPR-FPR最大点 (Youden's J) */
  bestByYouden: RocPoint;
  /** 手動レビュー用ペアサンプル */
  pairSamples: Array<{
    cosine: number;
    overlap: number;
    label: number; // 0|1 by proxy
    kwA: string;
    kwB: string;
  }>;
}

export function buildCosineEvidence(
  runId: string,
  pairs: PairOverlap[],
  positiveOverlapMin: number = 3,
): CosineEvidence {
  const vectors = loadRunVectors(runId);
  const vecMap = new Map(vectors.map((v) => [v.candidateId, v.vector] as const));
  const kwMap = new Map(vectors.map((v) => [v.candidateId, v.keyword] as const));

  // pairごとに (cosine, overlap, label)
  const items: Array<{ cos: number; overlap: number; label: number; a: number; b: number }> = [];
  for (const p of pairs) {
    const va = vecMap.get(p.candidateIdA);
    const vb = vecMap.get(p.candidateIdB);
    if (!va || !vb) continue;
    const c = cosine(va, vb);
    items.push({
      cos: c,
      overlap: p.overlap,
      label: p.overlap >= positiveOverlapMin ? 1 : 0,
      a: p.candidateIdA,
      b: p.candidateIdB,
    });
  }
  const positives = items.filter((x) => x.label === 1).length;
  const negatives = items.length - positives;

  // ヒストグラム (bins 0.0..1.0 step 0.05)
  const binsCount = 20;
  const bins = Array.from({ length: binsCount + 1 }, (_, i) => i / binsCount);
  const posC = new Array(binsCount).fill(0);
  const negC = new Array(binsCount).fill(0);
  for (const it of items) {
    const idx = Math.min(binsCount - 1, Math.max(0, Math.floor(it.cos * binsCount)));
    if (it.label === 1) posC[idx]++;
    else negC[idx]++;
  }

  // ROC: threshold 0..1 step 0.05
  const roc: RocPoint[] = [];
  for (let i = 0; i <= binsCount; i++) {
    const t = i / binsCount;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const it of items) {
      const pred = it.cos >= t ? 1 : 0;
      if (pred === 1 && it.label === 1) tp++;
      else if (pred === 1 && it.label === 0) fp++;
      else if (pred === 0 && it.label === 1) fn++;
      else tn++;
    }
    const tpr = positives === 0 ? 0 : tp / positives;
    const fpr = negatives === 0 ? 0 : fp / negatives;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const f1 = precision + tpr === 0 ? 0 : (2 * precision * tpr) / (precision + tpr);
    roc.push({ threshold: t, tp, fp, fn, tn, tpr, fpr, precision, f1 });
  }

  // AUC (台形)
  const sorted = [...roc].sort((a, b) => a.fpr - b.fpr);
  let auc = 0;
  for (let i = 1; i < sorted.length; i++) {
    const x1 = sorted[i - 1]!.fpr;
    const x2 = sorted[i]!.fpr;
    const y1 = sorted[i - 1]!.tpr;
    const y2 = sorted[i]!.tpr;
    auc += ((y1 + y2) / 2) * (x2 - x1);
  }

  const bestByF1 = roc.reduce((best, p) => (p.f1 > best.f1 ? p : best), roc[0]!);
  const bestByYouden = roc.reduce(
    (best, p) => (p.tpr - p.fpr > best.tpr - best.fpr ? p : best),
    roc[0]!,
  );

  // pair samples: 各cosine range帯から最大3件ずつ抜く
  const sortedItems = [...items].sort((a, b) => a.cos - b.cos);
  const sampleStep = Math.max(1, Math.floor(sortedItems.length / 30));
  const pairSamples: CosineEvidence['pairSamples'] = [];
  for (let i = 0; i < sortedItems.length; i += sampleStep) {
    const it = sortedItems[i]!;
    pairSamples.push({
      cosine: Number(it.cos.toFixed(4)),
      overlap: it.overlap,
      label: it.label,
      kwA: kwMap.get(it.a) ?? '',
      kwB: kwMap.get(it.b) ?? '',
    });
    if (pairSamples.length >= 30) break;
  }

  return {
    proxyLabel: `serp_overlap >= ${positiveOverlapMin}`,
    pairsTotal: items.length,
    positives,
    negatives,
    histogram: { bins, positiveCounts: posC, negativeCounts: negC },
    roc,
    auc: Number(auc.toFixed(4)),
    bestByF1,
    bestByYouden,
    pairSamples,
  };
}

export function suggestCosineCandidates(
  ev: CosineEvidence,
): Array<{ value: number; rationale: string }> {
  const out: Array<{ value: number; rationale: string }> = [
    {
      value: Number(ev.bestByF1.threshold.toFixed(2)),
      rationale: `F1 max (F1=${ev.bestByF1.f1.toFixed(3)}, P=${ev.bestByF1.precision.toFixed(3)}, R=${ev.bestByF1.tpr.toFixed(3)})`,
    },
    {
      value: Number(ev.bestByYouden.threshold.toFixed(2)),
      rationale: `Youden's J max (TPR=${ev.bestByYouden.tpr.toFixed(3)}, FPR=${ev.bestByYouden.fpr.toFixed(3)})`,
    },
  ];
  // 仕様の仮値 0.80
  if (!out.find((c) => Math.abs(c.value - 0.8) < 1e-6)) {
    const at080 = ev.roc.find((p) => Math.abs(p.threshold - 0.8) < 1e-6);
    out.push({
      value: 0.8,
      rationale: at080
        ? `spec default 0.80 (P=${at080.precision.toFixed(3)}, R=${at080.tpr.toFixed(3)})`
        : `spec default 0.80`,
    });
  }
  // dedupe
  const seen = new Set<number>();
  return out
    .filter((c) => (seen.has(c.value) ? false : (seen.add(c.value), true)))
    .sort((a, b) => a.value - b.value);
}
