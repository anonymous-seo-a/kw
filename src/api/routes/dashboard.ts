/**
 * Dashboard 用 API routes:
 *   GET /api/dashboard/:runId/diff       - DIFF表 (kw → page → metrics)
 *   GET /api/dashboard/:runId/topical    - hub/spoke tree
 *   GET /api/dashboard/:runId/graph      - nodes+edges (link graph)
 *   GET /api/dashboard/:runId/compliance - コンプラ充足 checklist
 *   GET /api/dashboard/:runId/truebeauty - 真=美5項目
 *   GET /api/dashboard/:runId/pages      - page一覧 (light)
 *   GET /api/dashboard/:runId/summary    - run統計 (totalcand/inregion/pages/etc)
 */
import { Router } from 'express';
import { kwDb } from '../../lib/db.js';
import { buildPageMembersCsv, groupByPage } from '../../export/csv.js';

export const dashboardRouter = Router();

dashboardRouter.get('/:runId/summary', (req, res) => {
  const db = kwDb();
  const run = db.prepare('SELECT * FROM runs WHERE run_id=?').get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'run not found' });
  const counts = {
    candidates: (
      db.prepare('SELECT COUNT(*) AS n FROM l1_candidates WHERE run_id=?').get(req.params.runId) as
        | { n: number }
        | undefined
    )?.n ?? 0,
    inRegion: (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM boundary_signals WHERE run_id=? AND signal_kind='density'`,
        )
        .get(req.params.runId) as { n: number } | undefined
    )?.n ?? 0,
    inventory: (
      db
        .prepare('SELECT COUNT(*) AS n FROM inventory_entities WHERE run_id=?')
        .get(req.params.runId) as { n: number } | undefined
    )?.n ?? 0,
    clusters: (
      db
        .prepare(`SELECT COUNT(*) AS n FROM l3_clusters WHERE run_id=? AND status='active'`)
        .get(req.params.runId) as { n: number } | undefined
    )?.n ?? 0,
    pages: (
      db.prepare('SELECT COUNT(*) AS n FROM cov_pages WHERE run_id=?').get(req.params.runId) as
        | { n: number }
        | undefined
    )?.n ?? 0,
    covered: (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM cov_assignments WHERE run_id=? AND page_id IS NOT NULL`,
        )
        .get(req.params.runId) as { n: number } | undefined
    )?.n ?? 0,
    uncovered: (
      db
        .prepare(`SELECT COUNT(*) AS n FROM cov_assignments WHERE run_id=? AND page_id IS NULL`)
        .get(req.params.runId) as { n: number } | undefined
    )?.n ?? 0,
  };
  res.json({ run, counts });
});

dashboardRouter.get('/:runId/pages', (req, res) => {
  const rows = kwDb()
    .prepare(
      `SELECT cp.page_id, cp.title_hint, cp.cover_size, cp.pick_order,
              json_extract(c.metric_json,'$.bucket') AS bucket,
              il.layer AS intent_layer,
              pr.score AS pagerank,
              dp.status AS diff_status
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       LEFT JOIN l4_intent_layers il ON il.run_id=cp.run_id AND il.page_id=cp.page_id
       LEFT JOIN l5_pagerank pr ON pr.run_id=cp.run_id AND pr.page_id=cp.page_id
       LEFT JOIN diff_pages dp ON dp.run_id=cp.run_id AND dp.page_id=cp.page_id
       WHERE cp.run_id=?
       ORDER BY cp.pick_order`,
    )
    .all(req.params.runId);
  res.json({ rows });
});

dashboardRouter.get('/:runId/diff', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 5000), 10000);
  const offset = Number(req.query.offset ?? 0);
  const rows = kwDb()
    .prepare(
      `SELECT
         lc.id AS candidate_id,
         lc.keyword,
         m.cluster_id,
         cp.page_id,
         cp.title_hint AS page_rep,
         json_extract(c.metric_json,'$.bucket') AS bucket,
         il.layer AS intent_layer,
         dp.status AS action,
         metrics.volume,
         metrics.kd,
         metrics.cpc,
         metrics.intent,
         lc.sources_json
       FROM l1_candidates lc
       LEFT JOIN l3_cluster_members m ON m.run_id=lc.run_id AND m.candidate_id=lc.id
       LEFT JOIN l3_clusters c ON c.run_id=lc.run_id AND c.cluster_id=m.cluster_id
       LEFT JOIN cov_pages cp ON cp.run_id=lc.run_id AND cp.cluster_id=COALESCE(c.absorbed_into, c.cluster_id)
       LEFT JOIN l4_intent_layers il ON il.run_id=cp.run_id AND il.page_id=cp.page_id
       LEFT JOIN diff_pages dp ON dp.run_id=cp.run_id AND dp.page_id=cp.page_id
       LEFT JOIN l2_metrics metrics ON metrics.candidate_id=lc.id
       WHERE lc.run_id=?
       ORDER BY (metrics.volume IS NULL) ASC, metrics.volume DESC, lc.id
       LIMIT ? OFFSET ?`,
    )
    .all(req.params.runId, limit, offset) as Array<Record<string, unknown>>;
  const total = (
    kwDb()
      .prepare('SELECT COUNT(*) AS n FROM l1_candidates WHERE run_id=?')
      .get(req.params.runId) as { n: number } | undefined
  )?.n ?? 0;
  const parsed = rows.map((r) => ({
    ...r,
    sources: r.sources_json
      ? (() => {
          try {
            return JSON.parse(String(r.sources_json));
          } catch {
            return [];
          }
        })()
      : [],
    sources_json: undefined,
  }));
  res.json({ total, rows: parsed });
});

dashboardRouter.get('/:runId/topical', (req, res) => {
  const nodes = kwDb()
    .prepare(
      `SELECT cp.page_id, cp.title_hint, cp.cover_size,
              json_extract(c.metric_json,'$.bucket') AS bucket,
              il.layer AS intent_layer,
              h.parent_page_id, h.depth, h.edge_type, h.cosine_to_parent,
              pr.score AS pagerank
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       LEFT JOIN l4_intent_layers il ON il.run_id=cp.run_id AND il.page_id=cp.page_id
       LEFT JOIN l4_hierarchy h ON h.run_id=cp.run_id AND h.page_id=cp.page_id
       LEFT JOIN l5_pagerank pr ON pr.run_id=cp.run_id AND pr.page_id=cp.page_id
       WHERE cp.run_id=?`,
    )
    .all(req.params.runId);
  res.json({ nodes });
});

dashboardRouter.get('/:runId/graph', (req, res) => {
  const nodes = kwDb()
    .prepare(
      `SELECT cp.page_id, cp.title_hint,
              json_extract(c.metric_json,'$.bucket') AS bucket,
              il.layer AS intent_layer,
              pr.score AS pagerank, cp.cover_size
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       LEFT JOIN l4_intent_layers il ON il.run_id=cp.run_id AND il.page_id=cp.page_id
       LEFT JOIN l5_pagerank pr ON pr.run_id=cp.run_id AND pr.page_id=cp.page_id
       WHERE cp.run_id=?`,
    )
    .all(req.params.runId);
  const edges = kwDb()
    .prepare(
      `SELECT source_page_id AS source, target_page_id AS target, link_type, weight
       FROM l5_links WHERE run_id=?`,
    )
    .all(req.params.runId);
  res.json({ nodes, edges });
});

dashboardRouter.get('/:runId/compliance', (req, res) => {
  const items = kwDb()
    .prepare(
      `SELECT item_id, title, issuer, law_or_doc_name, article, source_url,
              related_urls_json, last_revised, severity, verification_needed,
              status, covered_by_page_id, notes
       FROM compliance_floor_items WHERE run_id=? ORDER BY item_id`,
    )
    .all(req.params.runId);
  res.json({ items });
});

dashboardRouter.get('/:runId/truebeauty', (req, res) => {
  const rows = kwDb()
    .prepare(
      `SELECT check_kind, status, metric_json, rationale, checked_at
       FROM l6_truebeauty_checks WHERE run_id=? ORDER BY check_kind`,
    )
    .all(req.params.runId) as Array<{
    check_kind: string;
    status: string;
    metric_json: string;
    rationale: string;
    checked_at: number;
  }>;
  res.json({
    checks: rows.map((r) => ({
      kind: r.check_kind,
      status: r.status,
      metric: (() => {
        try {
          return JSON.parse(r.metric_json);
        } catch {
          return null;
        }
      })(),
      rationale: r.rationale,
    })),
  });
});

// CSV出力 (軸KW → 配下記事KW)
dashboardRouter.get('/:runId/csv', (req, res) => {
  const { csv, rowCount } = buildPageMembersCsv(req.params.runId);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="kw-${req.params.runId}-pages.csv"`,
  );
  res.setHeader('X-Row-Count', String(rowCount));
  res.send(csv);
});

// 階層view: page単位の配下記事KW (UIで「軸KW → 配下記事KW」一覧)
dashboardRouter.get('/:runId/page-members', (req, res) => {
  const groups = groupByPage(req.params.runId);
  res.json({ groups, pageCount: groups.length });
});

dashboardRouter.get('/:runId/page/:pageId', (req, res) => {
  const db = kwDb();
  const page = db
    .prepare(
      `SELECT cp.page_id, cp.title_hint, cp.cover_size, cp.cluster_id,
              json_extract(c.metric_json,'$.bucket') AS bucket,
              il.layer AS intent_layer,
              pr.score AS pagerank
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       LEFT JOIN l4_intent_layers il ON il.run_id=cp.run_id AND il.page_id=cp.page_id
       LEFT JOIN l5_pagerank pr ON pr.run_id=cp.run_id AND pr.page_id=cp.page_id
       WHERE cp.run_id=? AND cp.page_id=?`,
    )
    .get(req.params.runId, req.params.pageId);
  if (!page) return res.status(404).json({ error: 'page not found' });

  // メンバーKW (自身+absorbed_into=自身のクラスタのメンバ)
  const cid = (page as { cluster_id: string }).cluster_id;
  const members = db
    .prepare(
      `SELECT lc.id, lc.keyword, m.is_representative,
              metrics.volume, metrics.kd, metrics.cpc, metrics.intent
       FROM l3_cluster_members m
       JOIN l1_candidates lc ON lc.id=m.candidate_id
       LEFT JOIN l3_clusters c ON c.run_id=m.run_id AND c.cluster_id=m.cluster_id
       LEFT JOIN l2_metrics metrics ON metrics.candidate_id=lc.id
       WHERE m.run_id=? AND (m.cluster_id=? OR c.absorbed_into=?)
       ORDER BY (metrics.volume IS NULL) ASC, metrics.volume DESC`,
    )
    .all(req.params.runId, cid, cid);

  res.json({ page, members });
});
