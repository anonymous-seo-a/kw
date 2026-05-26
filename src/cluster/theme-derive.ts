/**
 * 修正A (spec-01): theme (軸) 導出
 *
 *   page-merge後の page 群を 8-12 themes に集約。
 *   軸名はKW文字列prefixではなく SERP意図ファミリーで導出する (spec原則):
 *   - 各 page の rep candidate ベクトルを取得
 *   - k-means (k = config 'spec01_theme_target_count', default 10) で cluster化
 *   - 各 cluster の代表 page 群を Claude に見せて theme name を命名
 *
 *   出力: themes + page_theme テーブル
 */
import { kwDb } from '../lib/db.js';
import { cosine } from '../lib/voyage.js';
import { loadRunVectors, centroid } from '../lib/embeddings.js';
import { getConfigOr } from '../lib/config.js';
import { claudeText } from '../lib/claude.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

interface PageInfo {
  page_id: string;
  cluster_id: string;
  rep_kw: string;
  bucket: string;
  cover_size: number;
  rep_candidate_id: number;
  centroid: Float32Array;
}

function loadPageInfos(runId: string): PageInfo[] {
  const db = kwDb();
  // NEC='page' かつ active cluster の中で cov_pages にも入ってる (= 実 page) を取る
  // ここでは「直近 phase4 で page になる予定の cluster」を読む。cov_pages はCOV後に決まるので、
  // ここでは nec_decisions.decision='page' AND cluster.status='active' で取る。
  const rows = db
    .prepare(
      `SELECT c.cluster_id,
              json_extract(c.metric_json,'$.bucket') AS bucket,
              c.size AS cover_size
       FROM l3_clusters c
       JOIN nec_decisions n ON n.run_id=c.run_id AND n.cluster_id=c.cluster_id
       WHERE c.run_id=? AND c.status='active' AND n.decision='page'`,
    )
    .all(runId) as Array<{ cluster_id: string; bucket: string | null; cover_size: number }>;

  const vectors = loadRunVectors(runId);
  const vecMap = new Map(vectors.map((v) => [v.candidateId, v.vector] as const));
  const out: PageInfo[] = [];
  for (const r of rows) {
    const memberIds = db
      .prepare(
        `SELECT lc.id AS cid, lc.keyword
         FROM l3_cluster_members m
         JOIN l1_candidates lc ON lc.id=m.candidate_id
         LEFT JOIN l3_clusters c ON c.run_id=m.run_id AND c.cluster_id=m.cluster_id
         WHERE m.run_id=? AND (m.cluster_id=? OR c.absorbed_into=?)`,
      )
      .all(runId, r.cluster_id, r.cluster_id) as Array<{ cid: number; keyword: string }>;
    const vecs = memberIds.map((m) => vecMap.get(m.cid)).filter((v): v is Float32Array => !!v);
    if (vecs.length === 0) continue;
    const cent = centroid(vecs);
    const rep = db
      .prepare(
        `SELECT m.candidate_id, lc.keyword FROM l3_cluster_members m
         JOIN l1_candidates lc ON lc.id=m.candidate_id
         WHERE m.run_id=? AND m.cluster_id=? AND m.is_representative=1 LIMIT 1`,
      )
      .get(runId, r.cluster_id) as { candidate_id: number; keyword: string } | undefined;
    // cov_pages から page_id を取る
    const pidRow = db
      .prepare(`SELECT page_id FROM cov_pages WHERE run_id=? AND cluster_id=?`)
      .get(runId, r.cluster_id) as { page_id: string } | undefined;
    out.push({
      page_id: pidRow?.page_id ?? `c_${r.cluster_id}`,
      cluster_id: r.cluster_id,
      rep_kw: rep?.keyword ?? '',
      bucket: r.bucket ?? '',
      cover_size: r.cover_size,
      rep_candidate_id: rep?.candidate_id ?? 0,
      centroid: cent,
    });
  }
  return out;
}

/** 簡易 k-means (cosine distance) */
function kmeans(pages: PageInfo[], k: number, maxIter = 30): number[] {
  const n = pages.length;
  if (n === 0 || k === 0) return [];
  if (n <= k) return pages.map((_, i) => i % k);

  // 初期 centroid: k-means++ 風 (= 既存vectorから散らして選択)
  const centroids: Float32Array[] = [];
  centroids.push(new Float32Array(pages[0]!.centroid));
  while (centroids.length < k) {
    // 各 page の min cosine distance を計算
    const dists = pages.map((p) =>
      Math.min(...centroids.map((c) => 1 - cosine(p.centroid, c))),
    );
    const total = dists.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i]!;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    centroids.push(new Float32Array(pages[idx]!.centroid));
  }

  const assign = new Array(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    // assign
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -1;
      for (let j = 0; j < k; j++) {
        const s = cosine(pages[i]!.centroid, centroids[j]!);
        if (s > bestSim) {
          bestSim = s;
          best = j;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    // update centroids
    for (let j = 0; j < k; j++) {
      const members = pages.filter((_, i) => assign[i] === j).map((p) => p.centroid);
      if (members.length === 0) continue;
      centroids[j] = centroid(members);
    }
    if (!changed) break;
  }
  return assign;
}

const SYSTEM_THEME_NAMING = `あなたはSEO情報設計の専門家です。AGAクリニックメディアサイトの記事群を 軸 (theme) で命名する役割です。

【入力】 ある theme (=記事クラスタ) に属する page 代表KW 群
【出力】 1つの theme 名 (日本語、4-12文字程度) + 短い理由

ルール:
- KW prefix (core/trust/format等) は使わず、SERP意図ファミリーの自然な日本語で命名
- 例: "クリニック総合おすすめ" / "オンライン診療" / "AGA薬剤" / "費用・料金" / "効果・経過" /
       "副作用・リスク" / "セルフチェック" / "地域別" / "口コミ・評判" / "予防・対策"
- 出力フォーマット JSON: {"name": "...", "rationale": "..."}

`;

interface ThemeNamed {
  cluster_idx: number;
  name: string;
  rationale: string;
  page_count: number;
}

async function nameTheme(idx: number, samplePages: PageInfo[]): Promise<ThemeNamed> {
  const sample = samplePages
    .sort((a, b) => b.cover_size - a.cover_size)
    .slice(0, 10)
    .map((p) => `- ${p.rep_kw} [bucket=${p.bucket}, cover=${p.cover_size}]`)
    .join('\n');
  const user = `theme ${idx + 1} に属する代表 page (${samplePages.length}件、cover上位):\n${sample}\n\nこのthemeの名前を JSON で返してください。`;
  const text = await claudeText({
    system: SYSTEM_THEME_NAMING,
    user,
    maxTokens: 400,
  });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) {
    return { cluster_idx: idx, name: `theme_${idx + 1}`, rationale: '', page_count: samplePages.length };
  }
  try {
    const obj = JSON.parse(m[0]) as { name?: string; rationale?: string };
    return {
      cluster_idx: idx,
      name: obj.name?.trim() || `theme_${idx + 1}`,
      rationale: obj.rationale ?? '',
      page_count: samplePages.length,
    };
  } catch {
    return { cluster_idx: idx, name: `theme_${idx + 1}`, rationale: '', page_count: samplePages.length };
  }
}

export interface ThemeDeriveResult {
  k: number;
  totalPages: number;
  themes: Array<{ theme_id: string; name: string; rationale: string; page_count: number; sample_reps: string[] }>;
  llmCalls: number;
}

export async function runThemeDerive(runId: string): Promise<ThemeDeriveResult> {
  const k = getConfigOr<number>('spec01_theme_target_count', 10);
  const pages = loadPageInfos(runId);
  if (pages.length === 0) {
    return { k, totalPages: 0, themes: [], llmCalls: 0 };
  }
  const effectiveK = Math.min(k, pages.length);
  const assign = kmeans(pages, effectiveK);

  // theme ごとに命名
  const byTheme = new Map<number, PageInfo[]>();
  for (let i = 0; i < pages.length; i++) {
    const t = assign[i]!;
    if (!byTheme.has(t)) byTheme.set(t, []);
    byTheme.get(t)!.push(pages[i]!);
  }
  const sortedThemes = [...byTheme.entries()].sort((a, b) => b[1].length - a[1].length);

  const themes: ThemeDeriveResult['themes'] = [];
  let llmCalls = 0;
  // 並列で命名
  const named = await Promise.all(
    sortedThemes.map(async ([clusterIdx, ps], visibleIdx) => {
      const r = await nameTheme(visibleIdx, ps);
      llmCalls++;
      return { clusterIdx, ps, ...r };
    }),
  );

  // DB保存
  const db = kwDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM page_theme WHERE run_id=?`).run(runId);
    db.prepare(`DELETE FROM themes WHERE run_id=?`).run(runId);
    const insTheme = db.prepare(
      `INSERT INTO themes (run_id, theme_id, theme_name, rationale, page_count) VALUES (?, ?, ?, ?, ?)`,
    );
    const insPT = db.prepare(`INSERT INTO page_theme (run_id, page_id, theme_id) VALUES (?, ?, ?)`);
    let i = 0;
    for (const t of named) {
      i++;
      const tid = `t_${String(i).padStart(2, '0')}`;
      insTheme.run(runId, tid, t.name, t.rationale, t.ps.length);
      themes.push({
        theme_id: tid,
        name: t.name,
        rationale: t.rationale,
        page_count: t.ps.length,
        sample_reps: t.ps.slice(0, 5).map((p) => p.rep_kw),
      });
      for (const p of t.ps) insPT.run(runId, p.page_id, tid);
    }
  })();

  audit({
    actor: 'system',
    eventType: 'theme_derive.complete',
    entityType: 'run',
    entityId: runId,
    after: { k: effectiveK, totalPages: pages.length, themes: themes.map((t) => ({ id: t.theme_id, name: t.name, n: t.page_count })) },
  });

  logger.info({ runId, k: effectiveK, totalPages: pages.length, themes: themes.length, llmCalls }, '[A] theme derive done');

  return { k: effectiveK, totalPages: pages.length, themes, llmCalls };
}
