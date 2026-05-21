/**
 * Validate that all expected tables exist in kw / shared DBs.
 */
import { kwDb, voyageCacheDb, serpCacheDb, closeAll } from '../src/lib/db.js';

const KW_TABLES = [
  'schema_migrations',
  'config',
  'master_audit_log',
  'master_rules',
  'master_completeness_checklist',
  'master_annotations',
  'runs',
  'l1_source_events',
  'l1_candidates',
  'l1_entities',
  'ahrefs_usage',
];
const VOYAGE_TABLES = ['voyage_embeddings'];
const SERP_TABLES = ['serp_results', 'serp_top_urls'];

function checkTables(db: ReturnType<typeof kwDb>, label: string, expected: string[]) {
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>).map((r) => r.name),
  );
  let missing = 0;
  for (const t of expected) {
    const ok = present.has(t);
    if (!ok) missing++;
    console.log(`  ${ok ? '✓' : '✗'} [${label}] ${t}`);
  }
  return missing;
}

let miss = 0;
miss += checkTables(kwDb(), 'kw', KW_TABLES);
miss += checkTables(voyageCacheDb(), 'voyage', VOYAGE_TABLES);
miss += checkTables(serpCacheDb(), 'serp', SERP_TABLES);
closeAll();

if (miss === 0) console.log('\nAll tables present.');
else console.log(`\nMISSING tables: ${miss}`);
process.exit(miss === 0 ? 0 : 1);
