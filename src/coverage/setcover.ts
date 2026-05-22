/**
 * [COV] 最小被覆 (greedy set cover):
 *   universe = inventory_entities
 *   sets = pages (= NEC='page' のクラスタ)
 *   各 page が「カバーする entity_key」=
 *     - その page (cluster) のメンバー候補の kw → entity_key='kw:<norm>'
 *     - その page の cache_key の上位URL/ドメイン → 'url:<url>' / 'domain:<dom>'
 *     - その page のメンバー候補の l2_entities → 'mid:<>' / 'name:<>'
 *   コンプラ・フロア entity_key='compliance:<id>' は明示割当のみ被覆 (= 自動被覆されない)
 *   → 最終被覆結果に 'compliance' uncovered が必ず最優先フラグで残る (仕様§6)
 *
 * 出力:
 *   - cov_pages: greedy で選ばれたページとカバー集合
 *   - cov_assignments: 各 entity → page (NULLなら未被覆)
 *   - compliance_floor_items.status を 'covered' / 'missing' に更新
 */
import { kwDb, serpCacheDb } from '../lib/db.js';
import { normalizeKeyword } from '../lib/normalize.js';
import { logger } from '../lib/logger.js';

export interface CoverageResult {
  totalEntities: number;
  totalPages: number;
  pickedPages: number;
  coveredEntities: number;
  uncoveredEntities: number;
  complianceCovered: number;
  complianceMissing: number;
}

function pageEntityKeys(
  runId: string,
  clusterId: string,
): Set<string> {
  const db = kwDb();
  const members = db
    .prepare(
      `SELECT lc.id, lc.keyword
       FROM l3_cluster_members m
       JOIN l1_candidates lc ON lc.id = m.candidate_id
       WHERE m.run_id=? AND m.cluster_id=?`,
    )
    .all(runId, clusterId) as Array<{ id: number; keyword: string }>;

  const keys = new Set<string>();
  if (members.length === 0) return keys;

  // kw:
  for (const m of members) keys.add(`kw:${normalizeKeyword(m.keyword)}`);

  // url: / domain: from each member's serp top URLs
  const cands = members.map((m) => m.id);
  const ph = cands.map(() => '?').join(',');
  const fpRows = db
    .prepare(`SELECT cache_key FROM l2_serp_fp WHERE candidate_id IN (${ph})`)
    .all(...cands) as Array<{ cache_key: string }>;
  const cks = [...new Set(fpRows.map((r) => r.cache_key))];
  if (cks.length > 0) {
    const ckPh = cks.map(() => '?').join(',');
    const urls = serpCacheDb()
      .prepare(`SELECT url, domain FROM serp_top_urls WHERE cache_key IN (${ckPh})`)
      .all(...cks) as Array<{ url: string; domain: string | null }>;
    for (const u of urls) {
      keys.add(`url:${u.url}`);
      if (u.domain) keys.add(`domain:${u.domain}`);
    }
  }

  // mid: / name: from each member's l2_entities
  const ents = db
    .prepare(`SELECT mid, name FROM l2_entities WHERE candidate_id IN (${ph})`)
    .all(...cands) as Array<{ mid: string | null; name: string }>;
  for (const e of ents) {
    if (e.mid) keys.add(`mid:${e.mid}`);
    else keys.add(`name:${normalizeKeyword(e.name)}`);
  }

  return keys;
}

export async function runCoverage(runId: string): Promise<CoverageResult> {
  const db = kwDb();

  // universe
  const invRows = db
    .prepare(`SELECT entity_key FROM inventory_entities WHERE run_id=?`)
    .all(runId) as Array<{ entity_key: string }>;
  const universe = new Set(invRows.map((r) => r.entity_key));

  // pages = NEC='page' のクラスタ
  const pageClusters = db
    .prepare(
      `SELECT n.cluster_id
       FROM nec_decisions n
       JOIN l3_clusters c ON c.run_id=n.run_id AND c.cluster_id=n.cluster_id
       WHERE n.run_id=? AND n.decision='page' AND c.status='active'`,
    )
    .all(runId) as Array<{ cluster_id: string }>;

  const sets = pageClusters.map((p) => ({
    clusterId: p.cluster_id,
    keys: pageEntityKeys(runId, p.cluster_id),
  }));

  // Greedy set cover
  const uncovered = new Set(universe);
  const picked: Array<{ pageId: string; clusterId: string; covers: string[]; order: number }> = [];
  const assignment = new Map<string, string>();
  let order = 0;

  while (uncovered.size > 0) {
    // どの page がuncoveredを一番多くカバーするか
    let bestIdx = -1;
    let bestCover: string[] = [];
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i]!;
      const cov: string[] = [];
      for (const k of s.keys) if (uncovered.has(k)) cov.push(k);
      if (cov.length > bestCover.length) {
        bestCover = cov;
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestCover.length === 0) break;
    order++;
    const pageId = `p_${String(order).padStart(4, '0')}`;
    picked.push({
      pageId,
      clusterId: sets[bestIdx]!.clusterId,
      covers: bestCover,
      order,
    });
    for (const k of bestCover) {
      uncovered.delete(k);
      assignment.set(k, pageId);
    }
    sets.splice(bestIdx, 1);
  }

  // persist
  db.transaction(() => {
    db.prepare(`DELETE FROM cov_pages WHERE run_id=?`).run(runId);
    db.prepare(`DELETE FROM cov_assignments WHERE run_id=?`).run(runId);

    const insPage = db.prepare(
      `INSERT INTO cov_pages (run_id, page_id, cluster_id, title_hint, covers_json, cover_size, pick_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insAssign = db.prepare(
      `INSERT INTO cov_assignments (run_id, entity_key, page_id) VALUES (?, ?, ?)`,
    );
    for (const p of picked) {
      const repKw = db
        .prepare(
          `SELECT representative_kw FROM l3_clusters WHERE run_id=? AND cluster_id=?`,
        )
        .get(runId, p.clusterId) as { representative_kw: string | null } | undefined;
      insPage.run(
        runId,
        p.pageId,
        p.clusterId,
        repKw?.representative_kw ?? null,
        JSON.stringify(p.covers),
        p.covers.length,
        p.order,
      );
    }
    // 全エンティティに assignment 書き込み (uncoveredは NULL)
    for (const k of universe) {
      insAssign.run(runId, k, assignment.get(k) ?? null);
    }

    // compliance_floor_items 更新
    const updCompl = db.prepare(
      `UPDATE compliance_floor_items
       SET status=?, covered_by_page_id=?
       WHERE run_id=? AND item_id=?`,
    );
    const complRows = db
      .prepare(`SELECT item_id FROM compliance_floor_items WHERE run_id=?`)
      .all(runId) as Array<{ item_id: string }>;
    for (const c of complRows) {
      const pageId = assignment.get(`compliance:${c.item_id}`);
      updCompl.run(pageId ? 'covered' : 'missing', pageId ?? null, runId, c.item_id);
    }
  })();

  const totalEntities = universe.size;
  const coveredEntities = totalEntities - uncovered.size;
  const complianceCovered = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM compliance_floor_items WHERE run_id=? AND status='covered'`,
      )
      .get(runId) as { n: number }
  ).n;
  const complianceMissing = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM compliance_floor_items WHERE run_id=? AND status='missing'`,
      )
      .get(runId) as { n: number }
  ).n;

  logger.info(
    {
      runId,
      totalEntities,
      pickedPages: picked.length,
      coveredEntities,
      uncoveredEntities: uncovered.size,
      complianceCovered,
      complianceMissing,
    },
    '[COV] greedy set cover done',
  );

  return {
    totalEntities,
    totalPages: pageClusters.length,
    pickedPages: picked.length,
    coveredEntities,
    uncoveredEntities: uncovered.size,
    complianceCovered,
    complianceMissing,
  };
}
