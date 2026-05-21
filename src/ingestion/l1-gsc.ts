/**
 * [L1] GSC 実クエリ取得（無料・一次データ）.
 *
 * greenfield モードでは siteUrl 未指定で空配列を返す（gracefully skip）。
 * existing/参考サイトが指定された場合のみ、seed を含むクエリを取得して候補に投入。
 */
import { pullGscQueries } from '../lib/gsc.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { logSourceEvent, upsertCandidates, type IncomingCandidate } from './candidates.js';

export interface GscL1Options {
  seedKw: string;
  siteUrl?: string;
  startDate?: string;
  endDate?: string;
  rowLimit?: number;
}

function defaultDateRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 90);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

export async function ingestGscL1(
  runId: string,
  opts: GscL1Options,
): Promise<{ rows: number; skipped: boolean }> {
  const siteUrl = opts.siteUrl ?? env.GSC_PROPERTY_URL;
  if (!siteUrl) {
    logger.info({ runId }, '[L1] GSC skipped (no GSC_PROPERTY_URL / siteUrl)');
    return { rows: 0, skipped: true };
  }
  const { start, end } = defaultDateRange();
  try {
    const rows = await pullGscQueries({
      siteUrl,
      startDate: opts.startDate ?? start,
      endDate: opts.endDate ?? end,
      queryContains: opts.seedKw,
      rowLimit: opts.rowLimit ?? 5000,
    });
    logSourceEvent(runId, 'gsc', opts.seedKw, { siteUrl, rowCount: rows.length, sample: rows.slice(0, 5) });
    const incoming: IncomingCandidate[] = rows.map((r) => ({
      keyword: r.query,
      source: {
        provider: 'gsc',
        meta: {
          siteUrl,
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
        },
      },
    }));
    const { inserted, mergedSources } = upsertCandidates(runId, incoming);
    logger.info({ rows: rows.length, inserted, mergedSources }, '[L1] GSC persisted');
    return { rows: rows.length, skipped: false };
  } catch (e) {
    logger.error({ err: (e as Error).message }, '[L1] GSC failed (continuing without)');
    return { rows: 0, skipped: true };
  }
}
