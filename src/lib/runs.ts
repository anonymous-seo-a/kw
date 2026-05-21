import { kwDb } from './db.js';
import { audit } from './audit.js';
import { makeRunId } from './normalize.js';
import { snapshotConfig } from './config.js';

export type Target = 'traditional' | 'geo' | 'both';
export type Scope = 'page' | 'cluster' | 'full_silo';
export type SiteMode = 'greenfield' | 'existing';

export interface RunInput {
  seedKw: string;
  target: Target;
  scope: Scope;
  siteMode: SiteMode;
  vertical?: string | null;
  existingUrls?: string[] | null;
}

export function createRun(input: RunInput): string {
  const runId = makeRunId();
  const snapshot = snapshotConfig();
  kwDb()
    .prepare(
      `INSERT INTO runs
         (run_id, seed_kw, target, scope, site_mode, vertical, existing_urls_json, status, config_snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?)`,
    )
    .run(
      runId,
      input.seedKw,
      input.target,
      input.scope,
      input.siteMode,
      input.vertical ?? null,
      input.existingUrls ? JSON.stringify(input.existingUrls) : null,
      snapshot,
    );
  audit({
    actor: 'system',
    eventType: 'run.create',
    entityType: 'run',
    entityId: runId,
    after: input,
  });
  return runId;
}

export function setRunStatus(runId: string, status: string, note?: string): void {
  kwDb()
    .prepare("UPDATE runs SET status=?, updated_at=strftime('%s','now') WHERE run_id=?")
    .run(status, runId);
  audit({
    actor: 'system',
    eventType: 'run.status',
    entityType: 'run',
    entityId: runId,
    after: { status },
    note,
  });
}
