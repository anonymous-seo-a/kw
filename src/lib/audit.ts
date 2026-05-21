import { kwDb } from './db.js';

export interface AuditEvent {
  actor: string;
  eventType: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  note?: string;
}

export function audit(ev: AuditEvent): void {
  kwDb()
    .prepare(
      `INSERT INTO master_audit_log
         (actor, event_type, entity_type, entity_id, before_json, after_json, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ev.actor,
      ev.eventType,
      ev.entityType ?? null,
      ev.entityId ?? null,
      ev.before === undefined ? null : JSON.stringify(ev.before),
      ev.after === undefined ? null : JSON.stringify(ev.after),
      ev.note ?? null,
    );
}
