/**
 * [L1] LLM fan-out 模擬.
 *
 * 目的: Google AI Mode 等の fan-out（seedクエリ → 8〜20本のサブクエリ展開）を Claude で再現。
 * 出力: サブクエリの配列（候補KWとして l1_candidates に投入）。
 *
 * ⚠ Ahrefs不使用。Claudeのみ。
 * ⚠ subqueries数は env.FANOUT_SUBQUERIES_{MIN,MAX} で制御（ハードコード禁止）。
 */
import { claudeText } from '../lib/claude.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { logSourceEvent, upsertCandidates, type IncomingCandidate } from './candidates.js';

export interface FanoutOptions {
  seedKw: string;
  vertical?: string | null;
  /** Override min/max from env. */
  min?: number;
  max?: number;
  /** Language hint. */
  language?: string;
}

export interface FanoutResult {
  subqueries: string[];
  rawText: string;
}

const SYSTEM = `あなたは検索意図リサーチの専門家です。
ユーザーが与えた1つの「seed検索キーワード」に対して、検索意図を網羅的に展開した
サブクエリ（fan-out subqueries）を、Google AI Mode の挙動を模擬するつもりで列挙します。

要件:
- 出力は JSON 配列 1つのみ。前後に説明文を書かない。
- 各サブクエリは日本語の検索クエリとして自然な短句（5〜30文字目安、句読点なし）。
- seed と完全同一の文字列は除く。
- 意図層を意識: 顕在ニーズ（比較・選び方・おすすめ）／潜在ニーズ（背景・原因・仕組み）／安心ニーズ（副作用・リスク・口コミ・料金）を混ぜる。
- 商業/情報/取引/案内 の意図バランスを取る。
- 同義語の言い換えだけの重複は避ける。
- 法令・医療領域では、薬剤名・効能の断定表現は避け、一般語にとどめる。`;

function buildUserPrompt(seed: string, n: number, vertical?: string | null, language?: string) {
  const lang = language ?? 'ja';
  const verticalNote = vertical ? `（領域: ${vertical}）` : '';
  return `seed: "${seed}" ${verticalNote}
言語: ${lang}
サブクエリを ${n} 本、JSON配列で返してください。例:
["...", "...", ...]`;
}

function tryParseList(text: string): string[] {
  // 出力先頭の ```json ... ``` も許容
  const m =
    text.match(/```json\s*([\s\S]*?)```/i) ??
    text.match(/```\s*([\s\S]*?)```/) ??
    [null, text];
  const body = (m[1] ?? text).trim();
  // 先頭に余計な文章があった場合: 最初の '[' から最後の ']' を抜く
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`fanout output is not a JSON array: ${text.slice(0, 200)}`);
  }
  const arr = JSON.parse(body.slice(start, end + 1)) as unknown;
  if (!Array.isArray(arr)) throw new Error('fanout: parsed value is not an array');
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

export async function runFanout(opts: FanoutOptions): Promise<FanoutResult> {
  const min = opts.min ?? env.FANOUT_SUBQUERIES_MIN;
  const max = opts.max ?? env.FANOUT_SUBQUERIES_MAX;
  const target = Math.min(max, Math.max(min, Math.round((min + max) / 2)));
  const user = buildUserPrompt(opts.seedKw, target, opts.vertical, opts.language);

  const text = await claudeText({ system: SYSTEM, user, maxTokens: 2048 });
  const subqueries = tryParseList(text);
  return { subqueries, rawText: text };
}

/**
 * Top-level: run fan-out and persist to DB.
 */
export async function ingestFanout(runId: string, opts: FanoutOptions): Promise<number> {
  logger.info({ seed: opts.seedKw }, '[L1] LLM fan-out start');
  const r = await runFanout(opts);
  logSourceEvent(runId, 'llm_fanout', opts.seedKw, {
    rawText: r.rawText,
    subqueries: r.subqueries,
    model: 'claude',
  });
  const incoming: IncomingCandidate[] = r.subqueries.map((q) => ({
    keyword: q,
    source: { provider: 'llm_fanout', meta: { seed: opts.seedKw } },
  }));
  const { inserted, mergedSources } = upsertCandidates(runId, incoming);
  logger.info(
    { count: r.subqueries.length, inserted, mergedSources },
    '[L1] LLM fan-out persisted',
  );
  return inserted;
}
