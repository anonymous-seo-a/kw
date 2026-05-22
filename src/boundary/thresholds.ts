/**
 * 校正値の取得 (config table 経由)。
 * 既定値は仕様 §4 の暫定値。Daikiが config:set で確定する。
 */
import { getConfigOr } from '../lib/config.js';

export function thresholds() {
  return {
    serpOverlapN: getConfigOr<number>('serp_overlap_n', 3),
    cosineThreshold: getConfigOr<number>('cosine_threshold', 0.8),
    densityGap: getConfigOr<number>('density_gap', 0.85),
    salienceCutoff: getConfigOr<number>('salience_cutoff', 0.01),
  };
}
