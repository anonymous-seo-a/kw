import { Router } from 'express';
import { kwDb } from '../../lib/db.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  try {
    const row = kwDb().prepare('SELECT 1 AS ok').get() as { ok: number };
    res.json({ ok: true, db: row.ok === 1, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
