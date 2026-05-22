/**
 * Phase 6 4成果物 export (要件§7):
 *   ① DIFF表        : kw → cluster → page → 意図層 → metrics → action → compliance_flag
 *   ② topical map   : hub/spoke ツリー (core_map / outer_map)
 *   ③ 内部リンクグラフ: 有向エッジ + PageRank
 *   ④ ページ別パッセージ仕様: {primary_cluster, owned_entities, fan-out_subqueries(=パッセージ),
 *                              supporting_entities, compliance_required[]}
 *
 * 出力: ./exports/<run_id>/{diff_table.json, topical_map.json, link_graph.json, page_specs.json}
 *       phase6_exports に metadata を記録。
 */
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { kwDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';

interface ExportInfo {
  artifact: string;
  filePath: string;
  byteSize: number;
  rowCount: number;
}

function persistMeta(runId: string, info: ExportInfo): void {
  kwDb()
    .prepare(
      `INSERT INTO phase6_exports (run_id, artifact, file_path, byte_size, row_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, artifact) DO UPDATE SET
         file_path=excluded.file_path, byte_size=excluded.byte_size,
         row_count=excluded.row_count, generated_at=strftime('%s','now')`,
    )
    .run(runId, info.artifact, info.filePath, info.byteSize, info.rowCount);
}

function writeJson(runId: string, artifact: string, data: unknown, rowCount: number): ExportInfo {
  const dir = resolve(`./exports/${runId}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${artifact}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  const byteSize = statSync(filePath).size;
  const info: ExportInfo = { artifact, filePath, byteSize, rowCount };
  persistMeta(runId, info);
  return info;
}

// ===== ① DIFF表 =====
export function exportDiffTable(runId: string): ExportInfo {
  const db = kwDb();
  // 全候補KWについて: kw → 所属cluster → 所属page → intent layer → 累積metrics → action → compliance
  const rows = db
    .prepare(
      `SELECT
         lc.id AS candidate_id,
         lc.keyword,
         lc.sources_json,
         m.cluster_id,
         COALESCE(c2.cluster_id, c.cluster_id) AS effective_cluster,
         cp.page_id,
         cp.title_hint,
         json_extract(c.metric_json,'$.bucket') AS bucket,
         il.layer AS intent_layer,
         dp.status AS diff_status,
         dp.mode AS diff_mode,
         dp.rationale AS diff_rationale,
         metrics.volume,
         metrics.kd,
         metrics.cpc,
         metrics.intent
       FROM l1_candidates lc
       LEFT JOIN l3_cluster_members m ON m.run_id=lc.run_id AND m.candidate_id=lc.id
       LEFT JOIN l3_clusters c ON c.run_id=lc.run_id AND c.cluster_id=m.cluster_id
       LEFT JOIN l3_clusters c2 ON c2.run_id=lc.run_id AND c2.cluster_id=c.absorbed_into
       LEFT JOIN cov_pages cp ON cp.run_id=lc.run_id AND cp.cluster_id=COALESCE(c.absorbed_into, c.cluster_id)
       LEFT JOIN l4_intent_layers il ON il.run_id=cp.run_id AND il.page_id=cp.page_id
       LEFT JOIN diff_pages dp ON dp.run_id=cp.run_id AND dp.page_id=cp.page_id
       LEFT JOIN l2_metrics metrics ON metrics.candidate_id=lc.id
       WHERE lc.run_id=?
       ORDER BY lc.id`,
    )
    .all(runId) as Array<Record<string, unknown>>;

  // コンプラフロア充足状況
  const compl = db
    .prepare(
      `SELECT item_id, title, status, covered_by_page_id, verification_needed
       FROM compliance_floor_items WHERE run_id=?`,
    )
    .all(runId);

  const diffTable = {
    runId,
    generatedAt: new Date().toISOString(),
    rowCount: rows.length,
    rows: rows.map((r) => ({
      candidate_id: r.candidate_id,
      keyword: r.keyword,
      sources: (() => {
        try {
          return JSON.parse(String(r.sources_json));
        } catch {
          return [];
        }
      })(),
      cluster_id: r.effective_cluster,
      page_id: r.page_id,
      page_rep: r.title_hint,
      bucket: r.bucket,
      intent_layer: r.intent_layer,
      action: r.diff_status, // 'new' (greenfield) / 'covered' / 'updated' (existing)
      mode: r.diff_mode,
      rationale: r.diff_rationale,
      metrics: {
        volume: r.volume ?? null,
        kd: r.kd ?? null,
        cpc: r.cpc ?? null,
        intent: r.intent ?? null,
      },
    })),
    compliance: compl,
  };
  return writeJson(runId, 'diff_table', diffTable, rows.length);
}

// ===== ② topical map =====
export function exportTopicalMap(runId: string): ExportInfo {
  const db = kwDb();
  // L4階層 + page metadata + intent layer
  const nodes = db
    .prepare(
      `SELECT cp.page_id, cp.title_hint, cp.cover_size,
              json_extract(c.metric_json,'$.bucket') AS bucket,
              il.layer AS intent_layer,
              h.parent_page_id, h.depth, h.edge_type,
              pr.score AS pagerank
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       LEFT JOIN l4_intent_layers il ON il.run_id=cp.run_id AND il.page_id=cp.page_id
       LEFT JOIN l4_hierarchy h ON h.run_id=cp.run_id AND h.page_id=cp.page_id
       LEFT JOIN l5_pagerank pr ON pr.run_id=cp.run_id AND pr.page_id=cp.page_id
       WHERE cp.run_id=?`,
    )
    .all(runId) as Array<Record<string, unknown>>;

  // core_map (depth 0,1) と outer_map (depth 2+) に分離
  const coreMap = nodes.filter((n) => Number(n.depth ?? 99) <= 1);
  const outerMap = nodes.filter((n) => Number(n.depth ?? 99) >= 2);

  const data = {
    runId,
    generatedAt: new Date().toISOString(),
    coreMap,
    outerMap,
    totalNodes: nodes.length,
  };
  return writeJson(runId, 'topical_map', data, nodes.length);
}

// ===== ③ 内部リンクグラフ =====
export function exportLinkGraph(runId: string): ExportInfo {
  const db = kwDb();
  const nodes = db
    .prepare(
      `SELECT cp.page_id, cp.title_hint,
              json_extract(c.metric_json,'$.bucket') AS bucket,
              il.layer AS intent_layer,
              pr.score AS pagerank
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       LEFT JOIN l4_intent_layers il ON il.run_id=cp.run_id AND il.page_id=cp.page_id
       LEFT JOIN l5_pagerank pr ON pr.run_id=cp.run_id AND pr.page_id=cp.page_id
       WHERE cp.run_id=?`,
    )
    .all(runId);
  const edges = db
    .prepare(
      `SELECT source_page_id, target_page_id, link_type, weight, rationale AS anchor_context
       FROM l5_links WHERE run_id=?`,
    )
    .all(runId);
  const data = { runId, generatedAt: new Date().toISOString(), nodes, edges };
  return writeJson(runId, 'link_graph', data, (nodes as unknown[]).length);
}

// ===== ④ ページ別パッセージ仕様 =====
// {primary_cluster, owned_entities, fan-out_subqueries(=パッセージ), supporting_entities,
//  compliance_required[]}
// knowledge_04 執筆指示書の構成層・実行層粒度
export function exportPageSpecs(runId: string): ExportInfo {
  const db = kwDb();
  const pages = db
    .prepare(
      `SELECT cp.page_id, cp.cluster_id, cp.title_hint, cp.cover_size, cp.covers_json,
              json_extract(c.metric_json,'$.bucket') AS bucket,
              il.layer AS intent_layer,
              pr.score AS pagerank
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       LEFT JOIN l4_intent_layers il ON il.run_id=cp.run_id AND il.page_id=cp.page_id
       LEFT JOIN l5_pagerank pr ON pr.run_id=cp.run_id AND pr.page_id=cp.page_id
       WHERE cp.run_id=?
       ORDER BY cp.pick_order`,
    )
    .all(runId) as Array<{
    page_id: string;
    cluster_id: string;
    title_hint: string | null;
    cover_size: number;
    covers_json: string;
    bucket: string | null;
    intent_layer: string | null;
    pagerank: number | null;
  }>;

  // vertical=medical なら共通でフロア要素を全page要件として追加 (Daikiが個別pageへ割り当て前提)
  const runRow = db
    .prepare(`SELECT vertical FROM runs WHERE run_id=?`)
    .get(runId) as { vertical: string | null };
  const complianceFloor =
    runRow.vertical === 'medical'
      ? (db
          .prepare(
            `SELECT item_id, title, issuer, law_or_doc_name, article, source_url, related_urls_json,
                    severity, verification_needed
             FROM compliance_floor_items WHERE run_id=?`,
          )
          .all(runId) as Array<Record<string, unknown>>)
      : [];

  const specs = pages.map((p) => {
    // owned_entities: page自身のクラスタ + absorbed_intoがこのclusterのメンバの全エンティティ
    const memberKws = db
      .prepare(
        `SELECT lc.id, lc.keyword,
                metrics.volume, metrics.kd, metrics.cpc, metrics.intent
         FROM l3_cluster_members m
         JOIN l1_candidates lc ON lc.id=m.candidate_id
         LEFT JOIN l3_clusters c ON c.run_id=m.run_id AND c.cluster_id=m.cluster_id
         LEFT JOIN l2_metrics metrics ON metrics.candidate_id=lc.id
         WHERE m.run_id=? AND (m.cluster_id=? OR c.absorbed_into=?)`,
      )
      .all(runId, p.cluster_id, p.cluster_id) as Array<{
      id: number;
      keyword: string;
      volume: number | null;
      kd: number | null;
      cpc: number | null;
      intent: string | null;
    }>;

    // fan-out subqueries: 代表 + 主要メンバを execution-level passage として列挙
    const fanoutPassages = memberKws.slice(0, 30).map((m) => ({
      kw: m.keyword,
      volume: m.volume,
      intent: m.intent,
    }));

    // supporting entities = covers の中で kw: 以外 (url/domain/mid/name = co-occurrence target)
    let covers: string[] = [];
    try {
      covers = JSON.parse(p.covers_json) as string[];
    } catch {
      /* noop */
    }
    const supportingEntities = covers.filter(
      (k) => !k.startsWith('kw:') && !k.startsWith('compliance:'),
    );

    return {
      page_id: p.page_id,
      title_hint: p.title_hint,
      bucket: p.bucket,
      intent_layer: p.intent_layer,
      cover_size: p.cover_size,
      pagerank: p.pagerank,
      primary_cluster: p.cluster_id,
      owned_kws: memberKws.length,
      fan_out_passages: fanoutPassages,
      supporting_entities: supportingEntities.slice(0, 30),
      supporting_entities_total: supportingEntities.length,
      compliance_required: complianceFloor, // vertical=medical 時に全page要件として参照
    };
  });

  const data = { runId, generatedAt: new Date().toISOString(), pages: specs };
  return writeJson(runId, 'page_spec', data, specs.length);
}

export interface ExportSummary {
  diff: ExportInfo;
  topicalMap: ExportInfo;
  linkGraph: ExportInfo;
  pageSpec: ExportInfo;
}

export function exportAllArtifacts(runId: string): ExportSummary {
  const r: ExportSummary = {
    diff: exportDiffTable(runId),
    topicalMap: exportTopicalMap(runId),
    linkGraph: exportLinkGraph(runId),
    pageSpec: exportPageSpecs(runId),
  };
  logger.info(
    {
      runId,
      summary: Object.values(r).map((i) => ({
        artifact: i.artifact,
        size: i.byteSize,
        rows: i.rowCount,
      })),
    },
    '[L6] 4成果物 export complete',
  );
  return r;
}
