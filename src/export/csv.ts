/**
 * CSV出力 — spec-01 修正D に従い 1行=1page。member は UI で確認。
 *
 * 行構造 (1 row = 1 page):
 *   page_id, theme, page_rep_kw, bucket, parent_location, intent_layer,
 *   page_cover_size, pagerank, rep_volume, action, member_count
 *
 * 並び順: theme → pagerank desc → cover desc
 */
import { kwDb } from '../lib/db.js';

// spec-01 修正D: 1 page = 1 row
interface PageRow {
  page_id: string;
  theme_id: string;
  theme_name: string;
  page_rep_kw: string;
  bucket: string;
  parent_location: string;
  intent_layer: string;
  page_cover_size: number;
  pagerank: number | null;
  rep_volume: number | null;
  action: string;
  member_count: number;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: PageRow[]): string {
  const headers = [
    'page_id',
    'theme_id',
    'theme_name',
    'page_rep_kw',
    'bucket',
    'parent_location',
    'intent_layer',
    'page_cover_size',
    'pagerank',
    'rep_volume',
    'member_count',
    'action',
  ];
  const out = [headers.join(',')];
  for (const r of rows) {
    out.push(
      [
        r.page_id,
        r.theme_id,
        r.theme_name,
        r.page_rep_kw,
        r.bucket,
        r.parent_location,
        r.intent_layer,
        r.page_cover_size,
        r.pagerank?.toFixed(6) ?? '',
        r.rep_volume ?? '',
        r.member_count,
        r.action,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return `${out.join('\n')}\n`;
}

/**
 * spec-01 修正D: 1 page = 1 row 形式の rows を組み立てる。
 */
export function buildPageRows(runId: string): PageRow[] {
  const db = kwDb();
  const rows = db
    .prepare(
      `SELECT
         cp.page_id,
         COALESCE(pt.theme_id, '') AS theme_id,
         COALESCE(th.theme_name, '') AS theme_name,
         cp.title_hint AS page_rep_kw,
         COALESCE(json_extract(c.metric_json,'$.bucket'), '') AS bucket,
         CASE
           WHEN json_extract(c.metric_json,'$.bucket') LIKE 'location:%' THEN
             COALESCE(
               (SELECT CASE WHEN lh.level='top' THEN lh.child_value ELSE lh.parent_value END
                FROM location_hierarchy lh
                WHERE lh.run_id=cp.run_id
                  AND lh.child_value = SUBSTR(json_extract(c.metric_json,'$.bucket'), LENGTH('location:')+1)),
               ''
             )
           ELSE ''
         END AS parent_location,
         COALESCE(il.layer, '') AS intent_layer,
         cp.cover_size AS page_cover_size,
         pr.score AS pagerank,
         (SELECT metrics.volume FROM l3_cluster_members m
          JOIN l2_metrics metrics ON metrics.candidate_id=m.candidate_id
          WHERE m.run_id=cp.run_id AND m.cluster_id=cp.cluster_id AND m.is_representative=1 LIMIT 1) AS rep_volume,
         COALESCE(dp.status, 'new') AS action,
         (SELECT COUNT(DISTINCT m.candidate_id) FROM l3_cluster_members m
          LEFT JOIN l3_clusters c2 ON c2.run_id=m.run_id AND c2.cluster_id=m.cluster_id
          WHERE m.run_id=cp.run_id AND (m.cluster_id=cp.cluster_id OR c2.absorbed_into=cp.cluster_id)) AS member_count
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       LEFT JOIN page_theme pt ON pt.run_id=cp.run_id AND pt.page_id=cp.page_id
       LEFT JOIN themes th ON th.run_id=cp.run_id AND th.theme_id=pt.theme_id
       LEFT JOIN l4_intent_layers il ON il.run_id=cp.run_id AND il.page_id=cp.page_id
       LEFT JOIN l5_pagerank pr ON pr.run_id=cp.run_id AND pr.page_id=cp.page_id
       LEFT JOIN diff_pages dp ON dp.run_id=cp.run_id AND dp.page_id=cp.page_id
       WHERE cp.run_id=?
       ORDER BY
         theme_id,
         pr.score DESC NULLS LAST,
         cp.cover_size DESC,
         cp.pick_order`,
    )
    .all(runId) as PageRow[];
  return rows;
}

export function buildPagesCsv(runId: string): { csv: string; rowCount: number } {
  const rows = buildPageRows(runId);
  return { csv: rowsToCsv(rows), rowCount: rows.length };
}

/**
 * (Legacy) 旧 flat 軸KW→member CSV — UI drill-down 用に残置。
 * UI dashboard で member 詳細を表示するため /api/dashboard/<>/page-members で使う。
 */
interface MemberRow {
  page_id: string;
  axis_kw: string;
  bucket: string;
  parent_location: string;
  intent_layer: string;
  page_cover_size: number;
  pagerank: number | null;
  member_kw: string;
  is_representative: number;
  volume: number | null;
  kd: number | null;
  cpc: number | null;
  intent: string | null;
}

export function buildPageMembersRows(runId: string): MemberRow[] {
  const db = kwDb();
  // page_bucket は **page levelの軸** (吸収先 cluster の bucket)。
  // member 元クラスタの bucket は使わない (同一page内で値が散らかるため)。
  // candidate_filters に該当する候補は page_id='(excluded:<kind>)' として明示。
  const rows = db
    .prepare(
      `SELECT
         CASE WHEN cf.candidate_id IS NOT NULL THEN '(excluded:' || cf.filter_kind || ')'
              ELSE COALESCE(cp.page_id, '(unassigned)') END AS page_id,
         CASE WHEN cf.candidate_id IS NOT NULL THEN ''
              ELSE COALESCE(cp.title_hint, '') END AS axis_kw,
         CASE WHEN cf.candidate_id IS NOT NULL THEN ''
              ELSE COALESCE(json_extract(page_c.metric_json,'$.bucket'), '') END AS bucket,
         -- location bucket時のみ親地名 (top自身/sub問わず top値を埋める。top=自身/sub=親)
         CASE
           WHEN cf.candidate_id IS NOT NULL THEN ''
           WHEN json_extract(page_c.metric_json,'$.bucket') LIKE 'location:%' THEN
             COALESCE(
               (SELECT CASE WHEN lh.level='top' THEN lh.child_value ELSE lh.parent_value END
                FROM location_hierarchy lh
                WHERE lh.run_id=cp.run_id
                  AND lh.child_value = SUBSTR(json_extract(page_c.metric_json,'$.bucket'), LENGTH('location:')+1)),
               ''
             )
           ELSE ''
         END AS parent_location,
         COALESCE(il.layer, '') AS intent_layer,
         COALESCE(cp.cover_size, 0) AS page_cover_size,
         pr.score AS pagerank,
         lc.keyword AS member_kw,
         CASE WHEN cf.candidate_id IS NOT NULL THEN 0
              WHEN m.is_representative=1 AND m.cluster_id = cp.cluster_id THEN 1
              ELSE 0 END AS is_representative,
         metrics.volume,
         metrics.kd,
         metrics.cpc,
         metrics.intent
       FROM l1_candidates lc
       LEFT JOIN candidate_filters cf ON cf.run_id=lc.run_id AND cf.candidate_id=lc.id
       LEFT JOIN l3_cluster_members m ON m.run_id=lc.run_id AND m.candidate_id=lc.id
       LEFT JOIN l3_clusters c ON c.run_id=lc.run_id AND c.cluster_id=m.cluster_id
       LEFT JOIN cov_pages cp ON cp.run_id=lc.run_id AND cp.cluster_id=COALESCE(c.absorbed_into, c.cluster_id)
       LEFT JOIN l3_clusters page_c ON page_c.run_id=cp.run_id AND page_c.cluster_id=cp.cluster_id
       LEFT JOIN l4_intent_layers il ON il.run_id=cp.run_id AND il.page_id=cp.page_id
       LEFT JOIN l5_pagerank pr ON pr.run_id=cp.run_id AND pr.page_id=cp.page_id
       LEFT JOIN l2_metrics metrics ON metrics.candidate_id=lc.id
       WHERE lc.run_id=?
       ORDER BY
         (cp.page_id IS NULL) ASC,          -- assigned先頭
         pr.score DESC NULLS LAST,           -- 重要page先
         cp.pick_order ASC NULLS LAST,
         CASE WHEN m.is_representative=1 AND m.cluster_id = cp.cluster_id THEN 0 ELSE 1 END ASC,
         (metrics.volume IS NULL) ASC,
         metrics.volume DESC,
         lc.id ASC`,
    )
    .all(runId) as MemberRow[];
  return rows;
}

/**
 * spec-01 修正D 後: CSV は 1 row=1 page。member 詳細は UI で確認。
 * 旧 buildPageMembersCsv は legacy として残置せず、buildPagesCsv に置換。
 */
export function buildPageMembersCsv(runId: string): { csv: string; rowCount: number } {
  return buildPagesCsv(runId);
}

/**
 * Hierarchical view用: page単位の集約 (UI表示用)
 */
export interface PageMembersGroup {
  page_id: string;
  axis_kw: string;
  bucket: string;
  parent_location: string;        // location bucket時のみ親地名 (top自身/sub親)
  intent_layer: string;
  pagerank: number | null;
  page_cover_size: number;
  members: Array<{
    keyword: string;
    is_representative: number;
    volume: number | null;
    kd: number | null;
    cpc: number | null;
    intent: string | null;
  }>;
}

export function groupByPage(runId: string): PageMembersGroup[] {
  const rows = buildPageMembersRows(runId);
  const map = new Map<string, PageMembersGroup>();
  for (const r of rows) {
    if (!map.has(r.page_id)) {
      map.set(r.page_id, {
        page_id: r.page_id,
        axis_kw: r.axis_kw,
        bucket: r.bucket,
        parent_location: r.parent_location ?? '',
        intent_layer: r.intent_layer,
        pagerank: r.pagerank,
        page_cover_size: r.page_cover_size,
        members: [],
      });
    }
    map.get(r.page_id)!.members.push({
      keyword: r.member_kw,
      is_representative: r.is_representative,
      volume: r.volume,
      kd: r.kd,
      cpc: r.cpc,
      intent: r.intent,
    });
  }
  return [...map.values()];
}
