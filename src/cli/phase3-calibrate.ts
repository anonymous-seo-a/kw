#!/usr/bin/env tsx
/**
 * CLI: Phase 3a 校正harness。
 *
 * 使い方:
 *   npm run phase3:calibrate -- --run-id <L2_done run_id>
 *
 * 出力:
 *   - calibration_reports に 4パラメータ各1行
 *   - stdout に人間可読サマリ + JSON (Daiki確定用)
 *   - exit後、Daiki が setConfig(key, value) で凍結する
 */
import { parseArgs } from 'node:util';
import { runCalibration } from '../calibration/run.js';
import { kwDb, closeAll } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { setRunStatus } from '../lib/runs.js';

const CONFIG_KEY_BY_PARAM: Record<string, string> = {
  serp_overlap_n: 'serp_overlap_n',
  cosine_threshold: 'cosine_threshold',
  density_gap: 'density_gap',
  salience_cutoff: 'salience_cutoff',
};

async function main() {
  const { values } = parseArgs({
    options: {
      'run-id': { type: 'string' },
      'positive-min': { type: 'string' },
    },
  });
  const runId = values['run-id'];
  if (!runId) {
    console.error('--run-id is required (use the run_id from [L2])');
    process.exit(2);
  }

  // run rows から seed_kw を読む
  const row = kwDb()
    .prepare('SELECT seed_kw, status FROM runs WHERE run_id=?')
    .get(runId) as { seed_kw: string; status: string } | undefined;
  if (!row) {
    console.error(`run not found: ${runId}`);
    process.exit(2);
  }
  if (!['l2_done', 'calibrate_done'].includes(row.status)) {
    console.error(`run status is "${row.status}"; expected l2_done. Run [L2] first.`);
    process.exit(2);
  }

  try {
    const positiveMin = values['positive-min'] ? Number(values['positive-min']) : undefined;
    const summaries = await runCalibration({ runId, seedKw: row.seed_kw, serpOverlapPositiveMin: positiveMin });

    console.log('\n=== Phase 3a 校正harness 完了 ===');
    console.log(`run_id: ${runId}    seed: "${row.seed_kw}"\n`);
    for (const s of summaries) {
      console.log(`--- ${s.parameter} (config key: ${CONFIG_KEY_BY_PARAM[s.parameter]}) ---`);
      for (const c of s.candidates) {
        const star = c.value === s.recommended.value ? '★' : ' ';
        console.log(`  ${star} value=${c.value}    ${c.rationale}`);
      }
      console.log(`  recommended: ${s.recommended.value}`);
      console.log();
    }
    console.log('⛔ Daikiゲート: calibration_reports は保存済み。');
    console.log('   値を確定したら以下のように凍結してください (Node REPL or TODO: CLI追加):');
    console.log("   import { setConfig } from './src/lib/config.js'");
    console.log("   setConfig('serp_overlap_n', 3, { setBy: 'daiki', note: 'calibrated against AGA pilot' })");
    console.log();
    console.log(JSON.stringify({ runId, summaries }, null, 2));
  } catch (e) {
    setRunStatus(runId, 'failed', (e as Error).message);
    logger.error({ err: (e as Error).stack }, 'calibration failed');
    process.exitCode = 1;
  } finally {
    closeAll();
  }
}

main();
