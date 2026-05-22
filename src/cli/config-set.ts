#!/usr/bin/env tsx
/**
 * CLI: config table への値凍結 (audit + versioning付き)。
 * Daiki が calibration_reports を見て確定した校正値を凍結する用途。
 *
 * 使い方:
 *   npm run config:set -- --key serp_overlap_n --value 3 --set-by daiki --note "AGA pilot calibrated"
 *   npm run config:set -- --key cosine_threshold --value 0.80 --set-by daiki
 *   npm run config:set -- --list           # 現行値一覧
 */
import { parseArgs } from 'node:util';
import { setConfig, listCurrentConfig } from '../lib/config.js';
import { kwDb, closeAll } from '../lib/db.js';

function syncCalibrationDecided(key: string, value: number, setBy: string): void {
  // calibration_reports.decided_value_json を更新（最新run の該当parameterのみ）
  const r = kwDb()
    .prepare(
      `SELECT id FROM calibration_reports WHERE parameter=? ORDER BY generated_at DESC LIMIT 1`,
    )
    .get(key) as { id: number } | undefined;
  if (!r) return;
  kwDb()
    .prepare(
      `UPDATE calibration_reports SET
         decided_value_json=?,
         decided_at=strftime('%s','now'),
         decided_by=?
       WHERE id=?`,
    )
    .run(JSON.stringify(value), setBy, r.id);
}

function main() {
  const { values } = parseArgs({
    options: {
      key: { type: 'string' },
      value: { type: 'string' },
      'set-by': { type: 'string', default: 'daiki' },
      note: { type: 'string' },
      list: { type: 'boolean', default: false },
    },
  });

  if (values.list) {
    const cfg = listCurrentConfig();
    console.log(JSON.stringify(cfg, null, 2));
    closeAll();
    return;
  }

  if (!values.key || values.value === undefined) {
    console.error('Usage: config:set -- --key <key> --value <json or number> [--note <text>] [--set-by daiki|system|calibration|claude-code]');
    console.error('       config:set -- --list');
    process.exit(2);
  }

  // value のパース: JSONを試し、失敗したらstringにフォールバック
  let parsed: any;
  try {
    parsed = JSON.parse(values.value);
  } catch {
    parsed = values.value;
  }

  const setBy = (values['set-by'] ?? 'daiki') as 'daiki' | 'system' | 'calibration' | 'claude-code';
  const version = setConfig(values.key, parsed, { setBy, note: values.note });

  // 校正パラメータの場合は calibration_reports.decided_* も同期
  if (['serp_overlap_n', 'cosine_threshold', 'density_gap', 'salience_cutoff'].includes(values.key)) {
    if (typeof parsed === 'number') syncCalibrationDecided(values.key, parsed, setBy);
  }

  console.log(JSON.stringify({ key: values.key, value: parsed, version, setBy, note: values.note ?? null }, null, 2));
  closeAll();
}

main();
