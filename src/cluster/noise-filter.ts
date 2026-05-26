/**
 * 修正C-2 (spec-01): noise page filter
 *
 *   page-merge後、残った page のうち下記条件を満たす page を「ノイズ」として除外:
 *     - cover_size ≤ config 'spec01_noise_cover_max' (default 1)
 *     - rep_volume ≤ 0 (null含む)
 *     - bucket が location:* AND sub level (location_hierarchy.level='sub')
 *
 *   実装: nec_decisions の decision を 'page' → 'noise_excluded' に変更。
 *   COV は decision='page' のみpage化するため、ノイズ page は cov_pages に出ない。
 *   候補KW自体は inventory に残る (= 出し切り担保)。
 */
import { kwDb } from '../lib/db.js';
import { getConfigOr } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

export interface NoiseFilterResult {
  threshold_cover_max: number;
  evaluated: number;
  excluded: number;
  samples: Array<{ cluster_id: string; bucket: string; rep_kw: string; cover: number; rep_vol: number | null }>;
}

export async function runNoiseFilter(runId: string): Promise<NoiseFilterResult> {
  const coverMax = getConfigOr<number>('spec01_noise_cover_max', 1);
  const db = kwDb();

  // 現在 page になっている (NEC='page') active cluster の中で noise 条件に該当するもの
  const candidates = db
    .prepare(
      `SELECT
         c.cluster_id,
         json_extract(c.metric_json,'$.bucket') AS bucket,
         cp.title_hint AS rep_kw,
         cp.cover_size,
         (SELECT metrics.volume FROM l3_cluster_members m
          JOIN l2_metrics metrics ON metrics.candidate_id=m.candidate_id
          WHERE m.run_id=c.run_id AND m.cluster_id=c.cluster_id AND m.is_representative=1
          LIMIT 1) AS rep_volume
       FROM l3_clusters c
       JOIN nec_decisions n ON n.run_id=c.run_id AND n.cluster_id=c.cluster_id AND n.decision='page'
       JOIN cov_pages cp ON cp.run_id=c.run_id AND cp.cluster_id=c.cluster_id
       WHERE c.run_id=? AND c.status='active'`,
    )
    .all(runId) as Array<{
    cluster_id: string;
    bucket: string | null;
    rep_kw: string | null;
    cover_size: number;
    rep_volume: number | null;
  }>;

  let excluded = 0;
  const samples: NoiseFilterResult['samples'] = [];

  const upd = db.prepare(
    `UPDATE nec_decisions SET decision='noise_excluded', reason=?
     WHERE run_id=? AND cluster_id=?`,
  );

  db.transaction(() => {
    for (const c of candidates) {
      const bucket = c.bucket ?? '';
      if (!bucket.startsWith('location:')) continue;
      if (c.cover_size > coverMax) continue;
      if ((c.rep_volume ?? 0) > 0) continue;
      // location sub レベルチェック
      const value = bucket.slice('location:'.length);
      const lh = db
        .prepare(`SELECT level FROM location_hierarchy WHERE run_id=? AND child_value=?`)
        .get(runId, value) as { level: string } | undefined;
      // level='sub' or 'unknown' は除外対象、'top' は除外しない (主要都市は残す)
      if (lh && lh.level === 'top') continue;

      upd.run(
        `noise: bucket=${bucket}, cover=${c.cover_size}, rep_vol=${c.rep_volume ?? 0} (sub-location with no signal)`,
        runId,
        c.cluster_id,
      );
      excluded++;
      if (samples.length < 15) {
        samples.push({
          cluster_id: c.cluster_id,
          bucket,
          rep_kw: c.rep_kw ?? '',
          cover: c.cover_size,
          rep_vol: c.rep_volume,
        });
      }
    }
  })();

  audit({
    actor: 'system',
    eventType: 'noise_filter.complete',
    entityType: 'run',
    entityId: runId,
    after: { threshold_cover_max: coverMax, evaluated: candidates.length, excluded },
  });

  logger.info(
    { runId, evaluated: candidates.length, excluded, threshold_cover_max: coverMax },
    '[C-2] noise filter done',
  );

  return { threshold_cover_max: coverMax, evaluated: candidates.length, excluded, samples };
}
