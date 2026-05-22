-- Migration 0009: 地域階層 (top: 都道府県/主要政令市 / sub: 区/駅/小都市)
-- 各 candidate_axes.axis='location' の axis_value (例: 三軒茶屋) に親 (例: 東京) を付与。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS location_hierarchy (
  run_id        TEXT NOT NULL,
  child_value   TEXT NOT NULL,        -- 三軒茶屋 / 梅田 / 東京 / 大阪 等
  parent_value  TEXT,                  -- 東京 / 大阪 ... or NULL (top自身)
  level         TEXT NOT NULL,         -- 'top' | 'sub' | 'unknown'
  confidence    REAL,
  source        TEXT NOT NULL DEFAULT 'claude',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, child_value),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_loc_h_parent ON location_hierarchy(run_id, parent_value);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0.9.0');
