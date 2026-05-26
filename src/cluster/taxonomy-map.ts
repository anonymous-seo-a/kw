/**
 * spec-02 修正B: top-down controlled taxonomy への page 割当て (k-means置換)
 *
 *   config 'spec02_taxonomy' に定義された 12 themes (T01..T12) を Claude で固定的に
 *   pageに割り当てる。grab-bag (旧 t_01) や 命名重複 (旧 t_02/03/05/08 地域系) を解消。
 *
 *   AGA以外のverticalでも config 上書き or Claude生成で同じ仕組み (vertical-agnostic)。
 */
import { kwDb } from '../lib/db.js';
import { claudeText } from '../lib/claude.js';
import { getConfigOr } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

interface TaxonomyTheme {
  id: string;
  name: string;
  desc: string;
}

interface PageInfo {
  page_id: string;
  rep_kw: string;
  bucket: string;
  cover_size: number;
  sample_members: string[];
}

interface ClassifyResult {
  page_id: string;
  theme_id: string;
  rationale?: string;
}

const BATCH = 30;

function buildSystem(themes: TaxonomyTheme[]): string {
  const lines = themes.map((t) => `${t.id} ${t.name} — ${t.desc}`).join('\n');
  return `あなたはSEO情報設計者です。AGAサイトの記事 (page) を以下の **固定taxonomy** に分類してください。

【taxonomy】
${lines}

【分類ルール】
- 各pageは **1つの theme** にだけ割り当てる
- bucket prefix (core/cost/format等) は参考にしない。**page 代表KW + member sample から SERP意図ファミリーで判定**
- 地域 page (location: で始まる bucket) は **必ず T02 地域** に集約 (オンライン・薬剤等の混在禁止)
- 「○○ おすすめ」「皮膚科おすすめ」「ランキング」「比較」「クリニック選び方」は T01
- 「オンライン診療」「○○ オンライン」は T04 (T01ではない)
- 「市販」「通販」「ドラッグストア」は T05
- 「○○いつから/効果/写真/年数経過」は T06
- 「料金/安い/相場/月額/保険適用」は T07
- 「副作用/リスク/効果ない」は T08
- 「AGAとは/原因/仕組み/遺伝/最新」は T09
- 「予防/セルフチェック/自分で対策」は T10
- 「女性/男性/20代/30代/学生」は T11
- 「口コミ/評判/後悔/失敗/知恵袋」は T12

【出力】 JSON配列のみ。各page: {page_id, theme_id, rationale (短く)}`;
}

function parseJson(text: string): unknown[] {
  const m = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/) ?? [null, text];
  const body = (m[1] ?? text).trim();
  const s = body.indexOf('[');
  const e = body.lastIndexOf(']');
  if (s < 0 || e < 0 || e <= s) throw new Error(`taxonomy classify not JSON: ${text.slice(0, 200)}`);
  const arr = JSON.parse(body.slice(s, e + 1));
  if (!Array.isArray(arr)) throw new Error('not array');
  return arr;
}

function loadPages(runId: string): PageInfo[] {
  const db = kwDb();
  const rows = db
    .prepare(
      `SELECT cp.page_id, cp.title_hint AS rep_kw, cp.cover_size,
              COALESCE(json_extract(c.metric_json,'$.bucket'), '') AS bucket
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       WHERE cp.run_id=?`,
    )
    .all(runId) as Array<{ page_id: string; rep_kw: string; cover_size: number; bucket: string }>;

  const out: PageInfo[] = [];
  for (const r of rows) {
    const members = db
      .prepare(
        `SELECT lc.keyword FROM l3_cluster_members m
         JOIN l1_candidates lc ON lc.id=m.candidate_id
         LEFT JOIN l3_clusters c2 ON c2.run_id=m.run_id AND c2.cluster_id=m.cluster_id
         WHERE m.run_id=? AND (m.cluster_id=(SELECT cluster_id FROM cov_pages WHERE run_id=? AND page_id=?) OR c2.absorbed_into=(SELECT cluster_id FROM cov_pages WHERE run_id=? AND page_id=?))
         LIMIT 8`,
      )
      .all(runId, runId, r.page_id, runId, r.page_id) as Array<{ keyword: string }>;
    out.push({
      page_id: r.page_id,
      rep_kw: r.rep_kw,
      bucket: r.bucket,
      cover_size: r.cover_size,
      sample_members: members.map((m) => m.keyword),
    });
  }
  return out;
}

export interface TaxonomyMapResult {
  totalPages: number;
  themes: Array<{ theme_id: string; theme_name: string; page_count: number }>;
  llmCalls: number;
}

export async function runTaxonomyMap(runId: string): Promise<TaxonomyMapResult> {
  const themes = getConfigOr<TaxonomyTheme[]>('spec02_taxonomy', []);
  if (!Array.isArray(themes) || themes.length === 0) {
    throw new Error('spec02_taxonomy config not set');
  }
  const db = kwDb();
  const pages = loadPages(runId);
  if (pages.length === 0) return { totalPages: 0, themes: [], llmCalls: 0 };

  const system = buildSystem(themes);
  const themeIds = new Set(themes.map((t) => t.id));
  const themeNameById = new Map(themes.map((t) => [t.id, t.name] as const));
  const assignments = new Map<string, string>();
  let llmCalls = 0;

  for (let i = 0; i < pages.length; i += BATCH) {
    const slice = pages.slice(i, i + BATCH);
    const user = `分類対象 (${slice.length}件):\n${slice
      .map(
        (p) =>
          `- page_id="${p.page_id}" bucket=${p.bucket} 代表KW="${p.rep_kw}" cover=${p.cover_size} sample=[${p.sample_members.slice(0, 5).join(' / ')}]`,
      )
      .join('\n')}\n\nJSON配列で返してください。`;
    try {
      const text = await claudeText({ system, user, maxTokens: 4096 });
      llmCalls++;
      const rows = parseJson(text) as ClassifyResult[];
      for (const r of rows) {
        if (typeof r.page_id === 'string' && typeof r.theme_id === 'string' && themeIds.has(r.theme_id)) {
          assignments.set(r.page_id, r.theme_id);
        }
      }
    } catch (e) {
      logger.error({ runId, err: (e as Error).message }, '[taxonomy] batch failed');
    }
  }

  // Override: location bucket page は強制的に T02
  for (const p of pages) {
    if (p.bucket.startsWith('location:')) {
      assignments.set(p.page_id, 'T02');
    }
  }

  // DB保存 (themes と page_theme を再利用 — 旧 t_XX を削除して T01..T12 に置換)
  db.transaction(() => {
    db.prepare(`DELETE FROM page_theme WHERE run_id=?`).run(runId);
    db.prepare(`DELETE FROM themes WHERE run_id=?`).run(runId);
    const insTheme = db.prepare(
      `INSERT INTO themes (run_id, theme_id, theme_name, rationale, page_count) VALUES (?, ?, ?, ?, ?)`,
    );
    const insPT = db.prepare(`INSERT INTO page_theme (run_id, page_id, theme_id) VALUES (?, ?, ?)`);
    const byTheme = new Map<string, number>();
    for (const [, tid] of assignments) byTheme.set(tid, (byTheme.get(tid) ?? 0) + 1);
    // 全theme記録 (page_count=0 でも残す)
    for (const t of themes) {
      insTheme.run(runId, t.id, t.name, t.desc, byTheme.get(t.id) ?? 0);
    }
    for (const [pid, tid] of assignments) insPT.run(runId, pid, tid);
  })();

  const out: TaxonomyMapResult['themes'] = themes.map((t) => ({
    theme_id: t.id,
    theme_name: t.name,
    page_count: [...assignments.values()].filter((v) => v === t.id).length,
  }));

  audit({
    actor: 'system',
    eventType: 'taxonomy_map.complete',
    entityType: 'run',
    entityId: runId,
    after: { totalPages: pages.length, llmCalls, themes: out.map((t) => ({ id: t.theme_id, n: t.page_count })) },
  });

  logger.info({ runId, totalPages: pages.length, llmCalls, themes: out.map((t) => `${t.theme_id}:${t.page_count}`).join(' ') }, '[taxonomy] done');

  return { totalPages: pages.length, themes: out, llmCalls };
}
