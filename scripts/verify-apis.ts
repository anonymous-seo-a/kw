/**
 * Live smoke-test external APIs (1 cheap call each).
 *  - Voyage: 1 token, "ping" → 1 embedding
 *  - Anthropic: very small message
 *  - SerpAPI: 1 autocomplete call for "AGA"
 *  - Google NLP: analyze "AGA" entities
 *  - GSC: optional skip if no GSC_PROPERTY_URL
 *
 * Ahrefs is intentionally NOT tested here ([L1] does not use it).
 */
import { env } from '../src/lib/env.js';
import { embed } from '../src/lib/voyage.js';
import { claudeText } from '../src/lib/claude.js';
import { googleAutocomplete } from '../src/lib/serpapi.js';
import { analyzeEntities } from '../src/lib/google-nlp.js';
import { pullGscQueries } from '../src/lib/gsc.js';
import { closeAll } from '../src/lib/db.js';

async function check(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name.padEnd(20)} ${detail}`);
  } catch (e) {
    console.log(`  ✗ ${name.padEnd(20)} ${(e as Error).message.slice(0, 200)}`);
  }
}

async function main() {
  console.log('Live API smoke (1 cheap call each)\n');

  await check('voyage', async () => {
    const r = await embed(['ping'], 'document');
    return `dim=${r.vectors[0]?.length}, tokens=${r.tokensUsed}, hits=${r.cacheHits}`;
  });

  await check('anthropic', async () => {
    const t = await claudeText({ user: 'Say "ok" in 2 chars.', maxTokens: 20 });
    return `reply=${t.slice(0, 40).replace(/\s+/g, ' ')}`;
  });

  await check('serpapi', async () => {
    const r = await googleAutocomplete('AGA', { gl: 'jp', hl: 'ja' });
    const sugg = (r.raw['suggestions'] as Array<{ value?: string }>) ?? [];
    return `fromCache=${r.fromCache} suggestions=${sugg.length}`;
  });

  await check('google-nlp', async () => {
    const ents = await analyzeEntities('AGA はおすすめのクリニックで治療する。', 'ja');
    return `entities=${ents.length} sample=${ents[0]?.name ?? '-'}`;
  });

  if (env.GSC_PROPERTY_URL) {
    await check('gsc', async () => {
      const end = new Date();
      const start = new Date(end);
      start.setDate(end.getDate() - 7);
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const rows = await pullGscQueries({
        startDate: iso(start),
        endDate: iso(end),
        rowLimit: 1,
      });
      return `rows=${rows.length}`;
    });
  } else {
    console.log('  - gsc                  skipped (GSC_PROPERTY_URL unset — greenfield OK)');
  }

  closeAll();
}

main();
