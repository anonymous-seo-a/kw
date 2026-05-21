/**
 * Print which env vars are set / unset.
 * Does NOT print values. For developers + CI sanity.
 */
import { env } from '../src/lib/env.js';

const checks: Array<[string, string | undefined, 'required' | 'optional']> = [
  ['NODE_ENV', env.NODE_ENV, 'required'],
  ['PORT', String(env.PORT), 'required'],
  ['DB_PATH', env.DB_PATH, 'required'],
  ['SHARED_VOYAGE_CACHE_PATH', env.SHARED_VOYAGE_CACHE_PATH, 'required'],
  ['SHARED_SERP_CACHE_PATH', env.SHARED_SERP_CACHE_PATH, 'required'],
  ['VOYAGE_API_KEY', env.VOYAGE_API_KEY ? '<set>' : undefined, 'required'],
  ['ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY ? '<set>' : undefined, 'required'],
  ['SERPAPI_KEY', env.SERPAPI_KEY ? '<set>' : undefined, 'required'],
  ['GOOGLE_APPLICATION_CREDENTIALS', env.GOOGLE_APPLICATION_CREDENTIALS, 'optional'],
  ['GSC_PROPERTY_URL', env.GSC_PROPERTY_URL, 'optional'],
  ['AHREFS_API_TOKEN', env.AHREFS_API_TOKEN ? '<set>' : undefined, 'optional'],
  ['ANTHROPIC_MODEL', env.ANTHROPIC_MODEL, 'required'],
];

let missing = 0;
for (const [k, v, level] of checks) {
  const ok = !!v;
  if (!ok && level === 'required') missing++;
  console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(34)} ${level.padEnd(8)} ${ok ? v : '(unset)'}`);
}
console.log(missing > 0 ? `\nMISSING required: ${missing}` : '\nAll required env set.');
process.exit(missing === 0 ? 0 : 1);
