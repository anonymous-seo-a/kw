#!/usr/bin/env tsx
/**
 * CLI: 軸KW→配下記事KW のCSV出力。
 *   npm run export:csv -- --run-id <run_id> [--out path]
 *
 * デフォルト出力: ./exports/<run_id>/page_members.csv
 */
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { closeAll } from '../lib/db.js';
import { buildPageMembersCsv } from '../export/csv.js';
import { logger } from '../lib/logger.js';

function main() {
  const { values } = parseArgs({
    options: { 'run-id': { type: 'string' }, out: { type: 'string' } },
  });
  const runId = values['run-id'];
  if (!runId) {
    console.error('--run-id is required');
    process.exit(2);
  }
  const out = values.out ?? resolve(`./exports/${runId}/page_members.csv`);
  mkdirSync(dirname(out), { recursive: true });
  const { csv, rowCount } = buildPageMembersCsv(runId);
  writeFileSync(out, csv, 'utf-8');
  logger.info({ runId, out, rowCount }, 'CSV written');
  console.log(JSON.stringify({ runId, file: out, rowCount }, null, 2));
  closeAll();
}

main();
