import { Router } from 'express';
import { kwDb } from '../../lib/db.js';

export const runsRouter = Router();

runsRouter.get('/', (_req, res) => {
  const rows = kwDb()
    .prepare(
      `SELECT run_id, seed_kw, target, scope, site_mode, vertical, status, created_at, updated_at
       FROM runs ORDER BY created_at DESC LIMIT 100`,
    )
    .all();
  res.json({ rows });
});

runsRouter.get('/:runId', (req, res) => {
  const row = kwDb().prepare('SELECT * FROM runs WHERE run_id=?').get(req.params.runId);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});
