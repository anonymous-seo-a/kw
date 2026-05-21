import { Router } from 'express';
import { kwDb } from '../../lib/db.js';

export const candidatesRouter = Router();

candidatesRouter.get('/:runId', (req, res) => {
  const rows = kwDb()
    .prepare(
      `SELECT id, keyword, keyword_norm, sources_json, first_seen_at
       FROM l1_candidates WHERE run_id=? ORDER BY id ASC`,
    )
    .all(req.params.runId) as Array<{
    id: number;
    keyword: string;
    keyword_norm: string;
    sources_json: string;
    first_seen_at: number;
  }>;
  const out = rows.map((r) => ({
    id: r.id,
    keyword: r.keyword,
    keyword_norm: r.keyword_norm,
    sources: JSON.parse(r.sources_json),
    first_seen_at: r.first_seen_at,
  }));
  res.json({ rows: out });
});

candidatesRouter.get('/:runId/summary', (req, res) => {
  const total = (
    kwDb()
      .prepare('SELECT COUNT(*) AS n FROM l1_candidates WHERE run_id=?')
      .get(req.params.runId) as { n: number }
  ).n;
  const byProvider = kwDb()
    .prepare(
      `SELECT json_each.value->>'provider' AS provider, COUNT(*) AS n
       FROM l1_candidates, json_each(l1_candidates.sources_json)
       WHERE run_id=? GROUP BY provider ORDER BY n DESC`,
    )
    .all(req.params.runId);
  res.json({ total, byProvider });
});
