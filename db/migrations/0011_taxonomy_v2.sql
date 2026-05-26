-- Migration 0011: spec-02 controlled taxonomy + modifier types + region roll-up

PRAGMA foreign_keys = ON;

-- modifier_values: vertical-specific values for the 6 controlled modifier types
CREATE TABLE IF NOT EXISTS modifier_values (
  run_id          TEXT NOT NULL,
  modifier_type   TEXT NOT NULL,  -- 'price' | 'channel' | 'provider' | 'audience' | 'format' | 'general'
  modifier_value  TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'claude',
  PRIMARY KEY (run_id, modifier_type, modifier_value),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

-- page → modifier mapping (optional metadata, page can have 0..n)
CREATE TABLE IF NOT EXISTS page_modifier (
  run_id          TEXT NOT NULL,
  page_id         TEXT NOT NULL,
  modifier_type   TEXT NOT NULL,
  modifier_value  TEXT,
  confidence      REAL,
  PRIMARY KEY (run_id, page_id, modifier_type),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

-- region roll-up log
CREATE TABLE IF NOT EXISTS region_rollups (
  run_id          TEXT NOT NULL,
  from_cluster_id TEXT NOT NULL,
  into_cluster_id TEXT NOT NULL,
  from_value      TEXT,
  into_value      TEXT,
  reason          TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, from_cluster_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0.11.0');
