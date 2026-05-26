#!/usr/bin/env tsx
/**
 * spec-01 分析: 現データから Daiki ゲート決定用の数値・候補を算出。
 *
 *   npm run spec01:analyze -- --run-id <run_id>
 *
 * 出力:
 *   - stdout に人間可読サマリー
 *   - ./exports/<run_id>/spec01-proposal.json に構造化データ
 *
 * 提案内容:
 *   1. SERP重複ヒストグラム + 推奨閾値 (N=何URL重複でマージするか)
 *   2. 閾値別マージ後page数テーブル (N=2..8)
 *   3. 軸タクソノミ案 (8-12軸目安)
 *   4. 地域商圏統合候補 (親-子 SERP重複 ≥ threshold)
 *   5. ノイズpage候補 (vol=0 + size≤1 + niche)
 */
import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { kwDb, serpCacheDb, closeAll } from '../lib/db.js';

const TOP_URL_LIMIT = 10;

interface Page {
  page_id: string;
  cluster_id: string;
  rep_kw: string;
  bucket: string;
  bucket_axis: string;   // 'core'|'location'|'cost'|...
  bucket_value: string;  // '東京' etc
  cover_size: number;
  rep_candidate_id: number;
  rep_volume: number | null;
  top_urls: string[];
}

function loadPages(runId: string): Page[] {
  const db = kwDb();
  const rows = db
    .prepare(
      `SELECT cp.page_id, cp.cluster_id, cp.title_hint AS rep_kw, cp.cover_size,
              json_extract(c.metric_json,'$.bucket') AS bucket
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       WHERE cp.run_id=?
       ORDER BY cp.pick_order`,
    )
    .all(runId) as Array<{ page_id: string; cluster_id: string; rep_kw: string; cover_size: number; bucket: string | null }>;

  const pages: Page[] = [];
  for (const r of rows) {
    const rep = db
      .prepare(
        `SELECT candidate_id FROM l3_cluster_members
         WHERE run_id=? AND cluster_id=? AND is_representative=1 LIMIT 1`,
      )
      .get(runId, r.cluster_id) as { candidate_id: number } | undefined;
    if (!rep) continue;
    const cacheKey = (db.prepare(`SELECT cache_key FROM l2_serp_fp WHERE candidate_id=?`).get(rep.candidate_id) as { cache_key: string } | undefined)?.cache_key;
    const urls = cacheKey
      ? (serpCacheDb()
          .prepare(`SELECT url FROM serp_top_urls WHERE cache_key=? ORDER BY rank LIMIT ?`)
          .all(cacheKey, TOP_URL_LIMIT) as Array<{ url: string }>).map((u) => u.url)
      : [];
    const repVol = (db.prepare(`SELECT volume FROM l2_metrics WHERE candidate_id=?`).get(rep.candidate_id) as { volume: number | null } | undefined)?.volume ?? null;
    const bucket = r.bucket ?? 'unknown:';
    const colon = bucket.indexOf(':');
    pages.push({
      page_id: r.page_id,
      cluster_id: r.cluster_id,
      rep_kw: r.rep_kw ?? '',
      bucket,
      bucket_axis: colon < 0 ? bucket : bucket.slice(0, colon),
      bucket_value: colon < 0 ? '' : bucket.slice(colon + 1),
      cover_size: r.cover_size,
      rep_candidate_id: rep.candidate_id,
      rep_volume: repVol,
      top_urls: urls,
    });
  }
  return pages;
}

function overlap(a: string[], b: string[]): number {
  const setB = new Set(b);
  let n = 0;
  for (const u of a) if (setB.has(u)) n++;
  return n;
}

function unionFindCluster(n: number): { parent: number[]; union: (a: number, b: number) => void; find: (x: number) => number } {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    if (parent[x] !== x) parent[x] = find(parent[x]!);
    return parent[x]!;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  return { parent, union, find };
}

function main() {
  const { values } = parseArgs({ options: { 'run-id': { type: 'string' } } });
  const runId = values['run-id'];
  if (!runId) { console.error('--run-id required'); process.exit(2); }

  const pages = loadPages(runId).filter((p) => p.top_urls.length > 0);
  console.log(`\n=== spec01 分析 (run_id=${runId}) ===`);
  console.log(`現状 page (top_urlあり) 数: ${pages.length}\n`);

  // ============================================================
  // 1. ペアSERP重複ヒストグラム
  // ============================================================
  const histogram = new Array(TOP_URL_LIMIT + 1).fill(0);
  const pairData: Array<{ i: number; j: number; ov: number }> = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const ov = overlap(pages[i]!.top_urls, pages[j]!.top_urls);
      histogram[Math.min(ov, TOP_URL_LIMIT)]++;
      if (ov >= 2) pairData.push({ i, j, ov });
    }
  }
  const totalPairs = (pages.length * (pages.length - 1)) / 2;
  const atLeast = new Array(TOP_URL_LIMIT + 1).fill(0);
  for (let n = TOP_URL_LIMIT; n >= 0; n--) atLeast[n] = (atLeast[n + 1] ?? 0) + histogram[n]!;

  console.log('【1】 SERP重複ヒストグラム (page pair)');
  console.log(`total pairs: ${totalPairs.toLocaleString()}`);
  console.log('overlap | pairs | %    | atLeast');
  for (let n = 0; n <= TOP_URL_LIMIT; n++) {
    const pct = ((histogram[n]! / totalPairs) * 100).toFixed(2);
    console.log(`  ${n.toString().padStart(2)}    | ${histogram[n]!.toString().padStart(6)} | ${pct.padStart(5)}% | ${atLeast[n]}`);
  }
  console.log();

  // ============================================================
  // 2. 閾値別マージ後page数 (union-find)
  // ============================================================
  console.log('【2】 閾値別: マージ後 page 数 (cross-bucket merge)');
  console.log('N(重複≥) | 後page数 | 削減数 | sample merged group (size)');
  const thresholdResults: Array<{ n: number; resultPages: number; reduction: number; topGroups: Array<{ size: number; rep_kw: string; sample: string[] }> }> = [];
  for (const N of [2, 3, 4, 5, 6, 7, 8]) {
    const uf = unionFindCluster(pages.length);
    for (const { i, j, ov } of pairData) if (ov >= N) uf.union(i, j);
    const groupMap = new Map<number, number[]>();
    for (let i = 0; i < pages.length; i++) {
      const r = uf.find(i);
      if (!groupMap.has(r)) groupMap.set(r, []);
      groupMap.get(r)!.push(i);
    }
    const groups = [...groupMap.values()].sort((a, b) => b.length - a.length);
    const topGroups = groups.slice(0, 3).filter((g) => g.length >= 2).map((g) => ({
      size: g.length,
      rep_kw: pages[g[0]!]!.rep_kw,
      sample: g.slice(0, 5).map((i) => pages[i]!.rep_kw),
    }));
    const result = { n: N, resultPages: groups.length, reduction: pages.length - groups.length, topGroups };
    thresholdResults.push(result);
    console.log(`  N=${N}   | ${groups.length.toString().padStart(7)}  | ${result.reduction.toString().padStart(6)} | ${topGroups[0]?.sample.slice(0, 3).join(' / ') ?? '-'}${topGroups[0] ? ` (size ${topGroups[0].size})` : ''}`);
  }
  console.log();

  // ============================================================
  // 3. 軸タクソノミ案 (8-12軸目安) — 各閾値でグループ数
  // ============================================================
  console.log('【3】 軸タクソノミ案: 閾値別 → グループ数の目安 (8-12軸を狙う閾値を選ぶ)');
  for (const r of thresholdResults) {
    if (r.resultPages >= 8 && r.resultPages <= 30) console.log(`  N=${r.n} → ${r.resultPages} group  ← 候補`);
  }
  // 推奨theme候補 — N=4 か 5 で大体収まる想定
  console.log();

  // ============================================================
  // 4. 地域商圏統合候補 (parent ↔ children のSERP重複)
  // ============================================================
  console.log('【4】 地域商圏統合候補');
  const db = kwDb();
  const loc = db
    .prepare(
      `SELECT child_value, parent_value, level FROM location_hierarchy WHERE run_id=?`,
    )
    .all(runId) as Array<{ child_value: string; parent_value: string | null; level: string }>;
  const parentOf = new Map(loc.map((l) => [l.child_value, l.parent_value]));
  const levelOf = new Map(loc.map((l) => [l.child_value, l.level]));

  // location bucketのpage を親別にグルーピング
  const locPages = pages.filter((p) => p.bucket_axis === 'location');
  const byParent = new Map<string, Page[]>();
  for (const p of locPages) {
    const parent = parentOf.get(p.bucket_value) ?? null;
    const key = parent ?? p.bucket_value;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(p);
  }
  const regionMergeCandidates: Array<{ parent: string; pages: Array<{ value: string; rep_kw: string; cover: number; rep_vol: number | null; overlap_with_parent: number | null }> }> = [];
  for (const [parent, ps] of byParent) {
    if (ps.length < 2) continue;
    // parentに該当するpage (= level=top の bucket_value=parent) を探す
    const parentPage = ps.find((p) => p.bucket_value === parent);
    const rows = ps.map((p) => ({
      value: p.bucket_value,
      rep_kw: p.rep_kw,
      cover: p.cover_size,
      rep_vol: p.rep_volume,
      overlap_with_parent: parentPage && parentPage !== p ? overlap(parentPage.top_urls, p.top_urls) : null,
    }));
    regionMergeCandidates.push({ parent, pages: rows.sort((a, b) => b.cover - a.cover) });
  }
  console.log(`parent 別 location page 群 (parent ≥ 2 children のみ):\n`);
  for (const g of regionMergeCandidates.slice(0, 8)) {
    console.log(`【${g.parent}】 page 数 ${g.pages.length}`);
    for (const p of g.pages.slice(0, 8)) {
      const ov = p.overlap_with_parent === null ? '-' : p.overlap_with_parent.toString();
      console.log(`  value=${p.value.padEnd(15)} cover=${p.cover.toString().padStart(3)} rep_vol=${(p.rep_vol ?? '—').toString().padStart(4)} overlap_with_parent=${ov} | "${p.rep_kw}"`);
    }
    console.log();
  }

  // ============================================================
  // 5. ノイズpage候補 (vol=0 + size≤1 + niche)
  // ============================================================
  const noisePages = pages
    .filter((p) => p.cover_size <= 2 && (p.rep_volume === null || p.rep_volume === 0))
    .sort((a, b) => a.cover_size - b.cover_size || (a.rep_volume ?? 0) - (b.rep_volume ?? 0));
  console.log(`【5】 ノイズ候補 (cover≤2 AND rep_volume≤0): ${noisePages.length} page`);
  for (const p of noisePages.slice(0, 25)) {
    console.log(`  ${p.page_id} | bucket=${p.bucket.padEnd(28)} | cover=${p.cover_size} | rep_vol=${p.rep_volume ?? '—'} | "${p.rep_kw}"`);
  }
  if (noisePages.length > 25) console.log(`  ... + ${noisePages.length - 25} more`);
  console.log();

  // ============================================================
  // 6. 同一bucket内 表記ゆれ候補 (location限定)
  // ============================================================
  console.log('【6】 表記ゆれ候補 (location bucket 内で類似値)');
  const locValues = [...new Set(locPages.map((p) => p.bucket_value))];
  const variantPairs: Array<{ a: string; b: string; reason: string }> = [];
  for (let i = 0; i < locValues.length; i++) {
    for (let j = i + 1; j < locValues.length; j++) {
      const a = locValues[i]!;
      const b = locValues[j]!;
      // 完全包含 or 軽い違い (スペース/大小/連結)
      const na = a.replace(/[\s　]/g, '').toLowerCase();
      const nb = b.replace(/[\s　]/g, '').toLowerCase();
      if (na === nb) variantPairs.push({ a, b, reason: 'space/case' });
      else if (na.includes(nb) || nb.includes(na)) variantPairs.push({ a, b, reason: 'substring' });
    }
  }
  for (const v of variantPairs.slice(0, 30)) console.log(`  ${v.a} ≈ ${v.b} (${v.reason})`);
  if (variantPairs.length > 30) console.log(`  ... + ${variantPairs.length - 30} more`);
  console.log();

  // ============================================================
  // 出力 JSON
  // ============================================================
  const outPath = resolve(`./exports/${runId}/spec01-proposal.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    runId,
    pagesAnalyzed: pages.length,
    totalPairs,
    histogram,
    atLeast,
    thresholdResults,
    regionMergeCandidates,
    noisePages: noisePages.map((p) => ({ page_id: p.page_id, bucket: p.bucket, cover: p.cover_size, rep_vol: p.rep_volume, rep_kw: p.rep_kw })),
    variantPairs,
  }, null, 2), 'utf-8');
  console.log(`JSON output: ${outPath}`);

  closeAll();
}

main();
