-- Migration 0001: initial schema
-- Applies the canonical content of db/schema.sql.
-- (See db/schema.sql for documented schema. Keep this file = schema.sql at the time of v0.1.0)

-- ⚠ idempotent: 全テーブルは IF NOT EXISTS

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS config (
  key         TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  value_json  TEXT NOT NULL,
  note        TEXT,
  set_by      TEXT,
  set_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  is_current  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, version)
);
CREATE INDEX IF NOT EXISTS idx_config_key_current ON config(key) WHERE is_current=1;

CREATE TABLE IF NOT EXISTS master_audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  actor        TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  before_json  TEXT,
  after_json   TEXT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_event ON master_audit_log(event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON master_audit_log(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS master_rules (
  rule_id     TEXT PRIMARY KEY,
  rule_kind   TEXT NOT NULL,
  vertical    TEXT,
  body_json   TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_rules_kind ON master_rules(rule_kind);
CREATE INDEX IF NOT EXISTS idx_rules_vertical ON master_rules(vertical) WHERE vertical IS NOT NULL;

CREATE TABLE IF NOT EXISTS master_completeness_checklist (
  item_id       TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  vertical      TEXT,
  title         TEXT NOT NULL,
  description   TEXT,
  legal_basis   TEXT,
  source_url    TEXT,
  severity      TEXT NOT NULL DEFAULT 'required',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_checklist_scope ON master_completeness_checklist(scope, vertical);

CREATE TABLE IF NOT EXISTS master_annotations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  author        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_annotations_target ON master_annotations(target_type, target_id);

CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  seed_kw       TEXT NOT NULL,
  target        TEXT NOT NULL,
  scope         TEXT NOT NULL,
  site_mode     TEXT NOT NULL,
  vertical      TEXT,
  existing_urls_json TEXT,
  status        TEXT NOT NULL DEFAULT 'created',
  config_snapshot_json TEXT,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_seed ON runs(seed_kw, created_at);

CREATE TABLE IF NOT EXISTS l1_source_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  provider      TEXT NOT NULL,
  input_query   TEXT,
  raw_json      TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l1_events_run ON l1_source_events(run_id, provider);

CREATE TABLE IF NOT EXISTS l1_candidates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  keyword         TEXT NOT NULL,
  keyword_norm    TEXT NOT NULL,
  sources_json    TEXT NOT NULL,
  first_seen_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(run_id, keyword_norm),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l1_candidates_run ON l1_candidates(run_id);

CREATE TABLE IF NOT EXISTS l1_entities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  source_query    TEXT NOT NULL,
  name            TEXT NOT NULL,
  type            TEXT,
  mid             TEXT,
  wikipedia_url   TEXT,
  salience        REAL,
  meta_json       TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l1_entities_run ON l1_entities(run_id);
CREATE INDEX IF NOT EXISTS idx_l1_entities_mid ON l1_entities(mid) WHERE mid IS NOT NULL;

CREATE TABLE IF NOT EXISTS ahrefs_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT,
  endpoint        TEXT NOT NULL,
  units_estimated INTEGER NOT NULL,
  units_actual    INTEGER,
  request_json    TEXT,
  response_meta_json TEXT,
  called_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_ahrefs_usage_run ON ahrefs_usage(run_id, called_at);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0.1.0');
