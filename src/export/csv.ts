/**
 * CSV出力: 「軸KW → 配下記事KW」形式 + flat row export。
 *
 * 想定ユースケース (Daiki): 「どの軸で、どのKWの記事を作るのか」を1表で確認し、
 * KW重複なく site 構成を組む。
 *
 * 行構造 (flat, 1 candidateKW = 1 row):
 *   page_id, axis_kw, bucket, intent_layer, page_cover_size, pagerank,
 *   member_kw, is_representative, volume, kd, cpc, intent
 *
 * 並び順: pagerank desc → page_id → is_representative desc → volume desc
 * KW重複は無し (各candidate_idは l3_cluster_members に1行のみ)。out-of-regionは末尾に page_id='(unassigned)' で含める。
 */
import { kwDb } from '../lib/db.js';

interface Row {
  page_id: string;
  axis_kw: string;
  bucket: string;
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

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: Row[]): string {
  const headers = [
    'page_id',
    'axis_kw',
    'bucket',
    'intent_layer',
    'page_cover_size',
    'pagerank',
    'member_kw',
    'is_representative',
    'volume',
    'kd',
    'cpc',
    'intent',
  ];
  const out = [headers.join(',')];
  for (const r of rows) {
    out.push(
      [
        r.page_id,
        r.axis_kw,
        r.bucket,
        r.intent_layer,
        r.page_cover_size,
        r.pagerank?.toFixed(6) ?? '',
        r.member_kw,
        r.is_representative,
        r.volume ?? '',
        r.kd ?? '',
        r.cpc ?? '',
        r.intent ?? '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return `${out.join('\n')}\n`;
}

/**
 * 軸KW → 配下記事KW 行列 を組み立てる。
 * 各memberKWは「所属page」または「(unassigned)」を持つ。
 */
export function buildPageMembersRows(runId: string): Row[] {
  const db = kwDb();
  // page_bucket は **page levelの軸** (吸収先 cluster の bucket)。
  // member 元クラスタの bucket は使わない (同一page内で値が散らかるため)。
  const rows = db
    .prepare(
      `SELECT
         COALESCE(cp.page_id, '(unassigned)') AS page_id,
         COALESCE(cp.title_hint, '') AS axis_kw,
         COALESCE(json_extract(page_c.metric_json,'$.bucket'), '') AS bucket,
         COALESCE(il.layer, '') AS intent_layer,
         COALESCE(cp.cover_size, 0) AS page_cover_size,
         pr.score AS pagerank,
         lc.keyword AS member_kw,
         CASE WHEN m.is_representative=1 AND m.cluster_id = cp.cluster_id THEN 1 ELSE 0 END AS is_representative,
         metrics.volume,
         metrics.kd,
         metrics.cpc,
         metrics.intent
       FROM l1_candidates lc
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
         -- ↑page level rep を最先頭、その後配下記事KW
         (metrics.volume IS NULL) ASC,
         metrics.volume DESC,
         lc.id ASC`,
    )
    .all(runId) as Row[];
  return rows;
}

export function buildPageMembersCsv(runId: string): { csv: string; rowCount: number } {
  const rows = buildPageMembersRows(runId);
  return { csv: rowsToCsv(rows), rowCount: rows.length };
}

/**
 * Hierarchical view用: page単位の集約 (UI表示用)
 */
export interface PageMembersGroup {
  page_id: string;
  axis_kw: string;
  bucket: string;
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
