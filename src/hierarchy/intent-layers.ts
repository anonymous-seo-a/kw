/**
 * [L4] 意図3層分類 (要件§3 / §8):
 *   - manifest  (顕在): 商業/比較/決定意図 (おすすめ/ランキング/比較/選び方/料金/購入)
 *   - latent    (潜在): 教育/背景理解 (とは/原因/仕組み/予防/遺伝/メカニズム)
 *   - reassurance (安心): 信頼/proof (口コミ/評判/失敗/後悔/副作用/効果ない)
 *
 * Claude で page 代表KWとbucket情報を見て一括分類。バケット情報があれば近似可能なので
 * 軽量プロンプトで済む。
 */
import { kwDb } from '../lib/db.js';
import { claudeText } from '../lib/claude.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

export type IntentLayer = 'manifest' | 'latent' | 'reassurance';

const SYSTEM = `あなたはSEO検索意図の3層分類器です。各pageを顕在/潜在/安心 のいずれかに分類してください。

3層定義:
- manifest (顕在): 商業/比較/決定意図。例: おすすめ/ランキング/比較/料金/購入/選び方/予約
- latent (潜在): 教育/背景。例: とは/原因/仕組み/予防/遺伝/メカニズム/種類/効果が出るまで
- reassurance (安心): 信頼/proof。例: 口コミ/評判/失敗/後悔/副作用/効果ない/危険/2ch/知恵袋

出力は JSON配列のみ。各pageに {page_id, layer, confidence(0-1), reason}。`;

interface ClassifyRow {
  page_id: string;
  layer: IntentLayer;
  confidence: number;
  reason?: string;
}

function parseJson(text: string): unknown[] {
  const m = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/) ?? [null, text];
  const body = (m[1] ?? text).trim();
  const s = body.indexOf('[');
  const e = body.lastIndexOf(']');
  if (s < 0 || e < 0 || e <= s) throw new Error(`intent layer output not array: ${text.slice(0, 200)}`);
  const arr = JSON.parse(body.slice(s, e + 1));
  if (!Array.isArray(arr)) throw new Error('not array');
  return arr;
}

const BATCH = 30;

export interface IntentLayerResult {
  totalPages: number;
  byLayer: Record<IntentLayer, number>;
  llmCalls: number;
}

export async function runIntentLayers(runId: string): Promise<IntentLayerResult> {
  const db = kwDb();
  const pages = db
    .prepare(
      `SELECT cp.page_id, cp.title_hint, json_extract(c.metric_json,'$.bucket') AS bucket, cp.cover_size
       FROM cov_pages cp
       JOIN l3_clusters c ON c.run_id=cp.run_id AND c.cluster_id=cp.cluster_id
       WHERE cp.run_id=?
       ORDER BY cp.pick_order`,
    )
    .all(runId) as Array<{
    page_id: string;
    title_hint: string | null;
    bucket: string | null;
    cover_size: number;
  }>;
  if (pages.length === 0) {
    return { totalPages: 0, byLayer: { manifest: 0, latent: 0, reassurance: 0 }, llmCalls: 0 };
  }

  const ins = db.prepare(
    `INSERT INTO l4_intent_layers (run_id, page_id, layer, confidence, rationale)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id, page_id) DO UPDATE SET
       layer=excluded.layer, confidence=excluded.confidence, rationale=excluded.rationale`,
  );

  const byLayer = { manifest: 0, latent: 0, reassurance: 0 };
  let llmCalls = 0;

  for (let i = 0; i < pages.length; i += BATCH) {
    const slice = pages.slice(i, i + BATCH);
    const user = `分類対象page (${slice.length}件):\n${slice
      .map(
        (p) =>
          `- page_id="${p.page_id}" bucket=${p.bucket} 代表KW="${p.title_hint ?? ''}" cover=${p.cover_size}`,
      )
      .join('\n')}\n\n各pageを {page_id, layer, confidence, reason} の JSON配列で返してください。`;
    try {
      const text = await claudeText({ system: SYSTEM, user, maxTokens: 4096 });
      const rows = parseJson(text) as ClassifyRow[];
      llmCalls++;
      const byId = new Map(rows.map((r) => [r.page_id, r] as const));
      db.transaction(() => {
        for (const p of slice) {
          const r = byId.get(p.page_id);
          const layer: IntentLayer = (r?.layer as IntentLayer) ?? 'manifest';
          if (!['manifest', 'latent', 'reassurance'].includes(layer)) continue;
          ins.run(runId, p.page_id, layer, r?.confidence ?? 0.5, r?.reason ?? null);
          byLayer[layer]++;
        }
      })();
      logger.info(
        { runId, batchIdx: Math.floor(i / BATCH), size: slice.length },
        '[L4] intent layers batch',
      );
    } catch (e) {
      logger.error(
        { runId, batchIdx: Math.floor(i / BATCH), err: (e as Error).message },
        '[L4] intent layers batch failed',
      );
    }
  }

  audit({
    actor: 'system',
    eventType: 'l4.intent_layers.complete',
    entityType: 'run',
    entityId: runId,
    after: { totalPages: pages.length, byLayer, llmCalls },
  });

  logger.info(
    { runId, totalPages: pages.length, byLayer, llmCalls },
    '[L4] intent layers done',
  );

  return { totalPages: pages.length, byLayer, llmCalls };
}
