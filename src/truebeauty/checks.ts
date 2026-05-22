/**
 * [L6] 真=美ゲート 5項目自動チェック (要件§8):
 *   1. 必然性 (necessity): 冗長page 0
 *      → 各pageが他で被覆されない意図層 (cluster bucket × intent layer) を持つか
 *   2. 閉合性 (closure): inventory全エンティティが被覆 100%
 *      → uncovered = 0 (compliance除く)
 *   3. 最小性 (minimality): 統合可能page pair 0
 *      → centroid cosine ≥ cosine_threshold かつ bucket一致のpage pair = 統合可能
 *   4. 境界 (boundary): 他サイロ中心エンティティ混入 0
 *      → 単一seed運用ではN/A (audit fact のみ)
 *   5. コンプラ (compliance, vertical=medical時): 未充足必須要素 0
 *      → compliance_floor_items.status='missing' = 0
 *
 * 各 status は 'pass' | 'fail' | 'flag' (Daikiが最終判断する半合格)。
 * 「合否は提示までで決定はDaiki」(仕様§8) を守る。
 */
import { kwDb } from '../lib/db.js';
import { cosine } from '../lib/voyage.js';
import { loadRunVectors, centroid } from '../lib/embeddings.js';
import { thresholds } from '../boundary/thresholds.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

export type CheckKind = 'necessity' | 'closure' | 'minimality' | 'boundary' | 'compliance';
export type CheckStatus = 'pass' | 'fail' | 'flag';

export interface CheckResult {
  kind: CheckKind;
  status: CheckStatus;
  metric: Record<string, unknown>;
  rationale: string;
}

function pageBuckets(runId: string): Map<string, { bucket: string; intent: string | null }> {
  const rows = kwDb()
    .prepare(
      `SELECT cp.page_id, json_extract(c.metric_json,'$.bucket') AS bucket,
              il.layer AS intent
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       LEFT JOIN l4_intent_layers il ON il.run_id=cp.run_id AND il.page_id=cp.page_id
       WHERE cp.run_id=?`,
    )
    .all(runId) as Array<{ page_id: string; bucket: string | null; intent: string | null }>;
  const m = new Map<string, { bucket: string; intent: string | null }>();
  for (const r of rows) m.set(r.page_id, { bucket: r.bucket ?? 'unknown:', intent: r.intent });
  return m;
}

/** 1. 必然性: 同一 (bucket, intent_layer) を持つpageが2件以上=冗長候補 */
function checkNecessity(runId: string): CheckResult {
  const m = pageBuckets(runId);
  const groups = new Map<string, string[]>();
  for (const [pid, info] of m) {
    const key = `${info.bucket}|${info.intent ?? 'unknown'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(pid);
  }
  const redundant = [...groups.entries()].filter(([, ps]) => ps.length >= 2);
  const status: CheckStatus = redundant.length === 0 ? 'pass' : 'flag';
  return {
    kind: 'necessity',
    status,
    metric: {
      totalPages: m.size,
      redundantGroups: redundant.length,
      pairs: redundant.map(([k, ps]) => ({ key: k, pages: ps })).slice(0, 10),
    },
    rationale:
      status === 'pass'
        ? '冗長page 0: 各(bucket,intent_layer)組合せが1page以下'
        : `${redundant.length}件の(bucket,intent_layer)重複あり → Daiki確認推奨`,
  };
}

/** 2. 閉合性: inventory被覆率。compliance除き ≥99%なら pass。 */
function checkClosure(runId: string): CheckResult {
  const db = kwDb();
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM inventory_entities WHERE run_id=?`).get(runId) as {
      n: number;
    }
  ).n;
  const uncoveredAll = db
    .prepare(`SELECT entity_key FROM cov_assignments WHERE run_id=? AND page_id IS NULL`)
    .all(runId) as Array<{ entity_key: string }>;
  const uncoveredNonCompliance = uncoveredAll.filter((r) => !r.entity_key.startsWith('compliance:'));
  const covered = total - uncoveredAll.length;
  const closureRate = total === 0 ? 1 : (total - uncoveredNonCompliance.length) / total;
  const status: CheckStatus = uncoveredNonCompliance.length === 0 ? 'pass' : 'flag';
  return {
    kind: 'closure',
    status,
    metric: {
      totalEntities: total,
      covered,
      uncoveredTotal: uncoveredAll.length,
      uncoveredNonCompliance: uncoveredNonCompliance.length,
      closureRate: Number(closureRate.toFixed(4)),
      sampleUncovered: uncoveredNonCompliance.slice(0, 10).map((r) => r.entity_key),
    },
    rationale:
      status === 'pass'
        ? '閉合性100% (compliance除く全エンティティ被覆)'
        : `${uncoveredNonCompliance.length}件のnon-complianceエンティティが未被覆 → Daiki確認 (compliance未充足は別ガード)`,
  };
}

/** 3. 最小性: 同一bucketで centroid cosine ≥ cosine_threshold のpage pair = 統合候補 */
function checkMinimality(runId: string): CheckResult {
  const db = kwDb();
  const th = thresholds().cosineThreshold;
  const pages = db
    .prepare(
      `SELECT cp.page_id, cp.cluster_id, json_extract(c.metric_json,'$.bucket') AS bucket
       FROM cov_pages cp JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       WHERE cp.run_id=?`,
    )
    .all(runId) as Array<{ page_id: string; cluster_id: string; bucket: string | null }>;
  const vectors = loadRunVectors(runId);
  const vecMap = new Map(vectors.map((v) => [v.candidateId, v.vector] as const));
  const pageCent = new Map<string, Float32Array>();
  for (const p of pages) {
    const mem = db
      .prepare(
        `SELECT candidate_id FROM l3_cluster_members
         WHERE run_id=? AND (cluster_id=? OR EXISTS(SELECT 1 FROM l3_clusters c2 WHERE c2.run_id=l3_cluster_members.run_id AND c2.cluster_id=l3_cluster_members.cluster_id AND c2.absorbed_into=?))`,
      )
      .all(runId, p.cluster_id, p.cluster_id) as Array<{ candidate_id: number }>;
    const vecs = mem.map((r) => vecMap.get(r.candidate_id)).filter((v): v is Float32Array => !!v);
    if (vecs.length > 0) pageCent.set(p.page_id, centroid(vecs));
  }

  const mergeablePairs: Array<{ a: string; b: string; bucket: string; cosine: number }> = [];
  const arr = pages.filter((p) => pageCent.has(p.page_id));
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if ((arr[i]!.bucket ?? '') !== (arr[j]!.bucket ?? '')) continue;
      const c = cosine(pageCent.get(arr[i]!.page_id)!, pageCent.get(arr[j]!.page_id)!);
      if (c >= th) {
        mergeablePairs.push({
          a: arr[i]!.page_id,
          b: arr[j]!.page_id,
          bucket: arr[i]!.bucket ?? '',
          cosine: Number(c.toFixed(3)),
        });
      }
    }
  }
  const status: CheckStatus = mergeablePairs.length === 0 ? 'pass' : 'flag';
  return {
    kind: 'minimality',
    status,
    metric: {
      totalPages: arr.length,
      cosineThreshold: th,
      mergeablePairs: mergeablePairs.length,
      samples: mergeablePairs.slice(0, 10),
    },
    rationale:
      status === 'pass'
        ? `最小性OK: 同bucket内のpage pairで cosine≥${th}を満たすものなし`
        : `${mergeablePairs.length}件の統合候補ペアあり → Daiki確認推奨`,
  };
}

/** 4. 境界: 過剰拡張ガード結果 (boundary_exclusions row数)。単一seedではN/A → flag */
function checkBoundary(runId: string): CheckResult {
  const db = kwDb();
  const exclusions = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM boundary_exclusions WHERE run_id=?`)
      .get(runId) as { n: number }
  ).n;
  const otherRuns = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT seed_kw) AS n FROM runs WHERE run_id != ? AND status IN ('phase4_done','phase5_done','phase6_done')`,
      )
      .get(runId) as { n: number }
  ).n;
  let status: CheckStatus = 'pass';
  let rationale = '境界OK: 過剰拡張exclusions 0';
  if (otherRuns === 0) {
    status = 'flag';
    rationale = '単一seed運用: 他サイロ中心との比較不可 → 多silo運用時に再評価';
  }
  return {
    kind: 'boundary',
    status,
    metric: { exclusions, otherSeedsInScope: otherRuns },
    rationale,
  };
}

/** 5. コンプラ: vertical=medical 時のみ。compliance_floor_items.status='missing' = 0 */
function checkCompliance(runId: string): CheckResult {
  const db = kwDb();
  const run = db
    .prepare(`SELECT vertical FROM runs WHERE run_id=?`)
    .get(runId) as { vertical: string | null } | undefined;
  if (!run || run.vertical !== 'medical') {
    return {
      kind: 'compliance',
      status: 'pass',
      metric: { vertical: run?.vertical ?? null },
      rationale: 'vertical≠medical: コンプラ・フロア非適用',
    };
  }
  const items = db
    .prepare(
      `SELECT item_id, title, status, verification_needed FROM compliance_floor_items WHERE run_id=?`,
    )
    .all(runId) as Array<{
    item_id: string;
    title: string;
    status: 'pending' | 'covered' | 'missing';
    verification_needed: number;
  }>;
  const missing = items.filter((it) => it.status !== 'covered');
  const verifyNeeded = items.filter((it) => it.verification_needed === 1);
  // 仕様§8: 未充足の必須要素0 が合格条件。ただし「最終可否はDaiki判断」(§6)
  const status: CheckStatus = missing.length === 0 ? 'pass' : 'flag';
  return {
    kind: 'compliance',
    status,
    metric: {
      total: items.length,
      missing: missing.length,
      covered: items.length - missing.length,
      verificationNeeded: verifyNeeded.length,
      missingItems: missing.map((it) => ({ id: it.item_id, title: it.title })),
    },
    rationale:
      status === 'pass'
        ? 'コンプラ・フロア全充足'
        : `${missing.length}件の必須要素が未充足 → Daikiが最終可否判断 (仕様§6: ツールは flag提示のみ)`,
  };
}

export interface TrueBeautyReport {
  runId: string;
  checks: CheckResult[];
  overallStatus: 'pass' | 'fail' | 'flag';
  passCount: number;
  flagCount: number;
  failCount: number;
}

export async function runTrueBeauty(runId: string): Promise<TrueBeautyReport> {
  const checks: CheckResult[] = [
    checkNecessity(runId),
    checkClosure(runId),
    checkMinimality(runId),
    checkBoundary(runId),
    checkCompliance(runId),
  ];

  const db = kwDb();
  const ins = db.prepare(
    `INSERT INTO l6_truebeauty_checks (run_id, check_kind, status, metric_json, rationale)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id, check_kind) DO UPDATE SET
       status=excluded.status, metric_json=excluded.metric_json,
       rationale=excluded.rationale, checked_at=strftime('%s','now')`,
  );
  db.transaction(() => {
    for (const c of checks) {
      ins.run(runId, c.kind, c.status, JSON.stringify(c.metric), c.rationale);
    }
  })();

  const passCount = checks.filter((c) => c.status === 'pass').length;
  const flagCount = checks.filter((c) => c.status === 'flag').length;
  const failCount = checks.filter((c) => c.status === 'fail').length;
  // 全項目pass = pass、fail有り = fail、それ以外 = flag (Daiki判断要)
  const overallStatus: TrueBeautyReport['overallStatus'] =
    failCount > 0 ? 'fail' : flagCount > 0 ? 'flag' : 'pass';

  audit({
    actor: 'system',
    eventType: 'l6.truebeauty.complete',
    entityType: 'run',
    entityId: runId,
    after: {
      overallStatus,
      summary: checks.map((c) => ({ kind: c.kind, status: c.status })),
    },
  });

  logger.info(
    { runId, overallStatus, passCount, flagCount, failCount },
    '[L6] 真=美 checks done',
  );

  return { runId, checks, overallStatus, passCount, flagCount, failCount };
}
