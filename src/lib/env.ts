import 'dotenv/config';
import { z } from 'zod';

// Accept SERPAPI_API_KEY as an alias for SERPAPI_KEY (matches existing local .env conventions).
if (!process.env.SERPAPI_KEY && process.env.SERPAPI_API_KEY) {
  process.env.SERPAPI_KEY = process.env.SERPAPI_API_KEY;
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4050),
  LOG_LEVEL: z.string().default('info'),

  DB_PATH: z.string().default('./db/kw.db'),
  SHARED_VOYAGE_CACHE_PATH: z.string().default('./db/voyage-cache.db'),
  SHARED_SERP_CACHE_PATH: z.string().default('./db/serp-cache.db'),

  VOYAGE_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  SERPAPI_KEY: z.string().optional(),

  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  GSC_PROPERTY_URL: z.string().optional(),

  AHREFS_API_TOKEN: z.string().optional(),
  AHREFS_UNIT_BUDGET_MONTHLY: z.coerce.number().int().positive().default(150_000),

  ANTHROPIC_MODEL: z.string().default('claude-opus-4-7'),

  FANOUT_SUBQUERIES_MIN: z.coerce.number().int().positive().default(8),
  FANOUT_SUBQUERIES_MAX: z.coerce.number().int().positive().default(20),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
