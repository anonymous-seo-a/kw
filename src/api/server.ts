import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { healthRouter } from './routes/health.js';
import { runsRouter } from './routes/runs.js';
import { candidatesRouter } from './routes/candidates.js';
import { dashboardRouter } from './routes/dashboard.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use('/health', healthRouter);
app.use('/api/runs', runsRouter);
app.use('/api/candidates', candidatesRouter);
app.use('/api/dashboard', dashboardRouter);

const distUi = resolve('dist/ui');
if (env.NODE_ENV === 'production' && existsSync(distUi)) {
  app.use(express.static(distUi));
  app.get('*', (_req, res) => {
    res.sendFile(resolve(distUi, 'index.html'));
  });
  logger.info({ distUi }, 'serving built UI from dist/ui');
}

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'kw server listening');
});
