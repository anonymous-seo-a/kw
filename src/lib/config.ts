/**
 * Config store with versioning + audit.
 *
 * 全しきい値・予算・モード設定はここ経由で読む。コードに数値を書かない。
 * Daikiが確定するまで初期値は未投入のままでよい（呼出側が default を持つ）。
 */
import { kwDb } from './db.js';
import { audit } from './audit.js';

export type ConfigValue = string | number | boolean | Record<string, unknown> | unknown[];

export function getConfig<T extends ConfigValue = ConfigValue>(key: string): T | undefined {
  const row = kwDb()
    .prepare('SELECT value_json FROM config WHERE key=? AND is_current=1')
    .get(key) as { value_json: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.value_json) as T;
}

export function getConfigOr<T extends ConfigValue>(key: string, fallback: T): T {
  const v = getConfig<T>(key);
  return v === undefined ? fallback : v;
}

export interface SetConfigOptions {
  note?: string;
  setBy: 'daiki' | 'system' | 'calibration' | 'claude-code';
}

/**
 * Set config (creates a new version). Audit-logged.
 * 既存の is_current=1 を 0 に下げ、version+1 で新規 insert。
 */
export function setConfig(key: string, value: ConfigValue, opts: SetConfigOptions): number {
  const db = kwDb();
  return db.transaction(() => {
    const cur = db
      .prepare('SELECT version, value_json FROM config WHERE key=? AND is_current=1')
      .get(key) as { version: number; value_json: string } | undefined;
    const nextVersion = (cur?.version ?? 0) + 1;
    if (cur) {
      db.prepare('UPDATE config SET is_current=0 WHERE key=? AND is_current=1').run(key);
    }
    db.prepare(
      `INSERT INTO config (key, version, value_json, note, set_by, is_current)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(key, nextVersion, JSON.stringify(value), opts.note ?? null, opts.setBy);
    audit({
      actor: opts.setBy,
      eventType: 'config.update',
      entityType: 'config',
      entityId: key,
      before: cur ? JSON.parse(cur.value_json) : null,
      after: value,
      note: opts.note,
    });
    return nextVersion;
  })();
}

export function listCurrentConfig(): Record<string, ConfigValue> {
  const rows = kwDb()
    .prepare('SELECT key, value_json FROM config WHERE is_current=1')
    .all() as Array<{ key: string; value_json: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json)]));
}

/**
 * Snapshot all current config — for storage on a run row.
 */
export function snapshotConfig(): string {
  return JSON.stringify(listCurrentConfig());
}
