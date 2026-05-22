/**
 * Ahrefs ユニット予算ガード（仕様§5）。
 * - 月予算は config key 'ahrefs_unit_budget_monthly' か env.AHREFS_UNIT_BUDGET_MONTHLY。
 * - Phase 2 ではガード機構の整備のみ。実際のAhrefsコールは [L3] 生存後 (Phase 4) で発火。
 */
import { kwDb } from './db.js';
import { env } from './env.js';
import { getConfigOr } from './config.js';
import { audit } from './audit.js';
import { logger } from './logger.js';

export class BudgetExceededError extends Error {
  constructor(
    public readonly requested: number,
    public readonly available: number,
    public readonly endpoint: string,
  ) {
    super(
      `Ahrefs unit budget exceeded (endpoint=${endpoint}): requested=${requested}, available=${available}`,
    );
    this.name = 'BudgetExceededError';
  }
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthlyBudgetUnits(): number {
  return getConfigOr<number>('ahrefs_unit_budget_monthly', env.AHREFS_UNIT_BUDGET_MONTHLY);
}

function ensureBudgetRow(month: string): void {
  kwDb()
    .prepare(`INSERT OR IGNORE INTO ahrefs_budget (month_yyyymm, budgeted_units) VALUES (?, ?)`)
    .run(month, monthlyBudgetUnits());
}

/**
 * Ahrefs課金policyに沿う保守的見積もり（実消費 ≤ 見積もり を担保）。
 *  - gsc_keywords: 0（無料）
 *  - keywords_explorer 系: 最小50 / (行 × フィールド)
 *  - 不明エンドポイントも min 50 でガード
 */
export function estimateUnits(input: {
  endpoint: string;
  rowCount: number;
  fields?: number;
}): number {
  if (input.endpoint === 'gsc_keywords') return 0;
  const fields = Math.max(1, input.fields ?? 1);
  return Math.max(50, input.rowCount * fields);
}

export function budgetStatus(): {
  month: string;
  budgeted: number;
  consumed: number;
  available: number;
} {
  const month = currentMonth();
  ensureBudgetRow(month);
  const row = kwDb()
    .prepare('SELECT budgeted_units, consumed_units FROM ahrefs_budget WHERE month_yyyymm=?')
    .get(month) as { budgeted_units: number; consumed_units: number };
  return {
    month,
    budgeted: row.budgeted_units,
    consumed: row.consumed_units,
    available: Math.max(0, row.budgeted_units - row.consumed_units),
  };
}

/** 超過なら BudgetExceededError を投げる。呼出側は catch して上位に報告し停止する。 */
export function assertAvailable(units: number, endpoint: string): void {
  const s = budgetStatus();
  if (units > s.available) throw new BudgetExceededError(units, s.available, endpoint);
}

/**
 * 実コールに紐づく消費を記録する:
 *   - ahrefs_usage: per-call ログ（既存テーブル）
 *   - ahrefs_budget: 当月カウンタ加算
 *   - audit log
 */
export function consume(input: {
  endpoint: string;
  estimated: number;
  actual?: number | null;
  runId?: string;
  request?: unknown;
  responseMeta?: unknown;
}): void {
  const month = currentMonth();
  ensureBudgetRow(month);
  const db = kwDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO ahrefs_usage
         (run_id, endpoint, units_estimated, units_actual, request_json, response_meta_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId ?? null,
      input.endpoint,
      input.estimated,
      input.actual ?? null,
      input.request === undefined ? null : JSON.stringify(input.request),
      input.responseMeta === undefined ? null : JSON.stringify(input.responseMeta),
    );
    const delta = input.actual ?? input.estimated;
    db.prepare(
      `UPDATE ahrefs_budget
         SET consumed_units = consumed_units + ?,
             last_updated_at = strftime('%s','now')
       WHERE month_yyyymm = ?`,
    ).run(delta, month);
  })();
  audit({
    actor: 'system',
    eventType: 'ahrefs.consume',
    entityType: 'ahrefs_budget',
    entityId: month,
    after: { endpoint: input.endpoint, estimated: input.estimated, actual: input.actual ?? null },
  });
  logger.info(
    { endpoint: input.endpoint, estimated: input.estimated, actual: input.actual },
    'ahrefs units consumed',
  );
}
