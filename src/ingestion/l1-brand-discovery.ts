/**
 * [L1-brand-discovery]:
 *   Ahrefs の matching/related/suggestions は seed と直接共起するKWしか拾わず、
 *   主要competitor brandが漏れる場合がある (Daiki指摘: 湘南美容, リバイブAGA, ゴリラ等)。
 *
 *   解決: Claudeに seed+vertical文脈で関連 competitor brand を列挙させ、
 *         各brand名で Ahrefs matching-terms を叩いて brand-modifier クエリを拡張。
 *
 * 仕様§5補足 (rev 2026-05-22-3): brand discoveryはvertical依存・Claude知識ベース。
 * 予算ガード経由 (ahrefs-budget)。1 seedあたり追加 ~10,000 unitsの想定。
 */
import { claudeText } from '../lib/claude.js';
import { callAhrefs } from '../lib/ahrefs.js';
import { BudgetExceededError } from '../lib/ahrefs-budget.js';
import { logger } from '../lib/logger.js';
import { logSourceEvent, upsertCandidates, type IncomingCandidate } from './candidates.js';

export interface BrandDiscoveryOptions {
  seedKw: string;
  vertical?: string | null;
  /** Claude生成のbrand数上限 (default 30) */
  maxBrands?: number;
  /** Brand毎のAhrefs matching-terms limit (default 50) */
  perBrandLimit?: number;
  country?: string;
}

export interface BrandDiscoveryResult {
  brandsListed: string[];
  brandsQueried: number;
  candidatesAdded: number;
  unitsTotal: number;
  budgetExceeded?: { brand: string; requested: number; available: number };
  errors: Array<{ brand: string; error: string }>;
}

const SYSTEM_BRANDS = `あなたは日本市場のSEO競合リサーチャです。指定された seed KW と vertical (領域) を見て、その市場で **エンドユーザーが検索しうる代表的な競合事業者/施設/サービス/製品ブランド名** を JSON配列で列挙します。

要件:
- 出力は JSON 配列のみ (前後説明禁止)
- 各要素は **そのブランドが日本のユーザー検索で実際に入力されうる表記** にする
- カバー範囲:
  * 大手チェーン (例: AGAなら 湘南美容クリニック / AGAスキンクリニック / 銀座総合美容クリニック / Dクリニック / ゴリラクリニック / クリニックフォア / DMMオンラインクリニック / AGAヘアクリニック等)
  * 中堅・新興 (例: 東京リボーンクリニック / リアス銀座クリニック / 広尾プレミアム等)
  * オンラインサービス (例: クリニックフォア / DMMオンライン / Dr.じゅん / hims等)
  * 医薬品/製品ブランド (例: プロペシア / ザガーロ / リアップ / スカルプD等)
  * 個人輸入/通販サイト (例: オオサカ堂 等)
- 一般名称 (クリニック/病院/治療/薬局/オンライン) は含めない
- 同一実体の別表記は1個に集約 (例: 湘南美容クリニック ≡ 湘南美容外科 → "湘南美容クリニック")
- 上限 ${'${maxBrands}'} 個まで`;

function buildUser(seedKw: string, vertical: string | null, maxBrands: number): string {
  return `seed KW: "${seedKw}"${vertical ? `\n領域: ${vertical}` : ''}\n\nこの市場で関連する competitor brand を最大 ${maxBrands} 個、JSON配列で列挙してください。\n例: ["AGAスキンクリニック", "湘南美容クリニック", ...]`;
}

function parseJsonArray(text: string): string[] {
  const m = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/) ?? [null, text];
  const body = (m[1] ?? text).trim();
  const s = body.indexOf('[');
  const e = body.lastIndexOf(']');
  if (s < 0 || e < 0 || e <= s) throw new Error(`brand list not JSON: ${text.slice(0, 200)}`);
  const arr = JSON.parse(body.slice(s, e + 1));
  if (!Array.isArray(arr)) throw new Error('brand list not array');
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

export async function ingestBrandDiscovery(
  runId: string,
  opts: BrandDiscoveryOptions,
): Promise<BrandDiscoveryResult> {
  const maxBrands = opts.maxBrands ?? 30;
  const perBrandLimit = opts.perBrandLimit ?? 50;

  // 1) Claudeで brand list 生成
  const system = SYSTEM_BRANDS.replace('${maxBrands}', String(maxBrands));
  const text = await claudeText({
    system,
    user: buildUser(opts.seedKw, opts.vertical ?? null, maxBrands),
    maxTokens: 2048,
  });
  let brands: string[];
  try {
    brands = parseJsonArray(text).slice(0, maxBrands);
  } catch (e) {
    logger.error({ runId, err: (e as Error).message, text: text.slice(0, 300) }, '[brand-discovery] Claude list parse failed');
    return { brandsListed: [], brandsQueried: 0, candidatesAdded: 0, unitsTotal: 0, errors: [] };
  }

  logger.info({ runId, brandsCount: brands.length }, '[brand-discovery] Claude listed brands');
  logSourceEvent(runId, 'claude_brand_list', opts.seedKw, { brands });

  // 2) brand を candidate として直接投入 (空クラスタになっても inventoryに残す)
  // 各 brand キーワード自体を candidateに
  const directInserted = upsertCandidates(
    runId,
    brands.map<IncomingCandidate>((b) => ({
      keyword: b,
      source: {
        provider: 'claude_brand_discovery',
        meta: { kind: 'brand_name', from: opts.seedKw },
      },
    })),
  );

  // 3) 各brand で Ahrefs matching-terms (broad) → brand-modifier クエリ拡張
  let unitsTotal = 0;
  let candidatesAdded = directInserted.inserted;
  let brandsQueried = 0;
  let budgetExceeded: BrandDiscoveryResult['budgetExceeded'];
  const errors: BrandDiscoveryResult['errors'] = [];

  for (const brand of brands) {
    try {
      const r = await callAhrefs({
        endpoint: 'matching-terms',
        keyword: brand,
        country: opts.country ?? 'jp',
        limit: perBrandLimit,
        runId,
      });
      brandsQueried++;
      unitsTotal += r.unitsActual;
      const inc: IncomingCandidate[] = r.rows
        .map((row) => (row.keyword ?? '').trim())
        .filter(Boolean)
        .map<IncomingCandidate>((kw) => ({
          keyword: kw,
          source: {
            provider: 'ahrefs_brand_discovery',
            meta: { brand, from: opts.seedKw },
          },
        }));
      const ins = upsertCandidates(runId, inc);
      candidatesAdded += ins.inserted;
      logSourceEvent(runId, 'ahrefs_brand_discovery', brand, {
        rows: r.rows.length,
        inserted: ins.inserted,
        unitsActual: r.unitsActual,
      });
      logger.info(
        { runId, brand, rows: r.rows.length, inserted: ins.inserted, units: r.unitsActual },
        '[brand-discovery] brand expanded',
      );
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        budgetExceeded = { brand, requested: e.requested, available: e.available };
        logger.error(
          { runId, brand, requested: e.requested, available: e.available },
          '[brand-discovery] budget exceeded — stopping',
        );
        break;
      }
      errors.push({ brand, error: (e as Error).message });
      logger.error({ runId, brand, err: (e as Error).message }, '[brand-discovery] failed');
    }
  }

  return {
    brandsListed: brands,
    brandsQueried,
    candidatesAdded,
    unitsTotal,
    budgetExceeded,
    errors,
  };
}
