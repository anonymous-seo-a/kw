/**
 * spec-02 修正C: 地域 roll-up
 *
 *   sub-level location page で rep_volume=0 AND cover≤2 のものを、
 *   親 (parent_location が指す top-level) の page に吸収する。
 *   親pageが存在しない場合は除外 (nec_decision='noise_excluded' に降格)。
 *
 *   薄い都市pageの doorway リスク回避 + 構造的整理を同時達成。
 */
import { kwDb } from '../lib/db.js';
import { getConfigOr } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

interface RollupRule extends Record<string, unknown> {
  sub_vol_max: number;
  sub_cover_max: number;
  absorb_into: 'parent' | 'exclude';
}

export interface RegionRollupResult {
  evaluated: number;
  rolledUp: number;
  excludedNoParent: number;
  samples: Array<{ from: string; into: string; from_value: string; into_value: string; reason: string }>;
}

export async function runRegionRollup(runId: string): Promise<RegionRollupResult> {
  const rule = getConfigOr<RollupRule>('spec02_region_rollup_rule', {
    sub_vol_max: 0,
    sub_cover_max: 2,
    absorb_into: 'parent',
  });

  const db = kwDb();
  const rows = db
    .prepare(
      `SELECT cp.page_id, cp.cluster_id, cp.cover_size, cp.title_hint,
              SUBSTR(json_extract(c.metric_json,'$.bucket'), LENGTH('location:')+1) AS loc_value,
              (SELECT metrics.volume FROM l3_cluster_members m
               JOIN l2_metrics metrics ON metrics.candidate_id=m.candidate_id
               WHERE m.run_id=cp.run_id AND m.cluster_id=cp.cluster_id AND m.is_representative=1 LIMIT 1) AS rep_volume,
              lh.level AS lh_level, lh.parent_value AS parent_value
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       LEFT JOIN location_hierarchy lh ON lh.run_id=cp.run_id
         AND lh.child_value = SUBSTR(json_extract(c.metric_json,'$.bucket'), LENGTH('location:')+1)
       WHERE cp.run_id=? AND json_extract(c.metric_json,'$.bucket') LIKE 'location:%'`,
    )
    .all(runId) as Array<{
    page_id: string;
    cluster_id: string;
    cover_size: number;
    title_hint: string;
    loc_value: string;
    rep_volume: number | null;
    lh_level: string | null;
    parent_value: string | null;
  }>;

  let evaluated = 0;
  let rolledUp = 0;
  let excludedNoParent = 0;
  const samples: RegionRollupResult['samples'] = [];

  const updCluster = db.prepare(
    `UPDATE l3_clusters SET status='absorbed', absorbed_into=? WHERE run_id=? AND cluster_id=?`,
  );
  const updNec = db.prepare(
    `UPDATE nec_decisions SET decision='passage_absorbed', absorbed_into=?, reason=?
     WHERE run_id=? AND cluster_id=?`,
  );
  const updNecExclude = db.prepare(
    `UPDATE nec_decisions SET decision='noise_excluded', reason=? WHERE run_id=? AND cluster_id=?`,
  );
  const insRollup = db.prepare(
    `INSERT INTO region_rollups (run_id, from_cluster_id, into_cluster_id, from_value, into_value, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    db.prepare(`DELETE FROM region_rollups WHERE run_id=?`).run(runId);
    for (const r of rows) {
      // sub レベル かつ noise条件 ?
      if (r.lh_level !== 'sub') continue;
      if (r.cover_size > rule.sub_cover_max) continue;
      if ((r.rep_volume ?? 0) > rule.sub_vol_max) continue;
      evaluated++;

      // 親 page を見つける
      if (!r.parent_value) {
        // 親不明 → noise_excluded
        updNecExclude.run(`region_rollup: sub '${r.loc_value}' parent unknown`, runId, r.cluster_id);
        updCluster.run(null, runId, r.cluster_id);
        excludedNoParent++;
        continue;
      }

      const parentPage = db
        .prepare(
          `SELECT cp.page_id, cp.cluster_id FROM cov_pages cp
           JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
           WHERE cp.run_id=? AND json_extract(c.metric_json,'$.bucket')='location:' || ?`,
        )
        .get(runId, r.parent_value) as { page_id: string; cluster_id: string } | undefined;

      if (!parentPage) {
        updNecExclude.run(
          `region_rollup: sub '${r.loc_value}' parent='${r.parent_value}' page not present`,
          runId,
          r.cluster_id,
        );
        updCluster.run(null, runId, r.cluster_id);
        excludedNoParent++;
        continue;
      }

      const reason = `region_rollup: sub '${r.loc_value}' (cover=${r.cover_size}, vol=${r.rep_volume ?? 0}) → parent '${r.parent_value}' (${parentPage.cluster_id})`;
      updNec.run(parentPage.cluster_id, reason, runId, r.cluster_id);
      updCluster.run(parentPage.cluster_id, runId, r.cluster_id);
      insRollup.run(runId, r.cluster_id, parentPage.cluster_id, r.loc_value, r.parent_value, reason);
      rolledUp++;
      if (samples.length < 20)
        samples.push({
          from: r.cluster_id,
          into: parentPage.cluster_id,
          from_value: r.loc_value,
          into_value: r.parent_value,
          reason,
        });
    }
  })();

  audit({
    actor: 'system',
    eventType: 'region_rollup.complete',
    entityType: 'run',
    entityId: runId,
    after: { evaluated, rolledUp, excludedNoParent, rule },
  });

  logger.info(
    { runId, evaluated, rolledUp, excludedNoParent, rule },
    '[C] region roll-up done',
  );

  return { evaluated, rolledUp, excludedNoParent, samples };
}
