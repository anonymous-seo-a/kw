-- Migration 0003: Phase 3 — 校正ハーネス + [B]領域境界 + [INV]インベントリ
-- 校正値は Daiki が config table に凍結する（このマイグレーションでは値を投入しない）。

PRAGMA foreign_keys = ON;

-- 校正harness 1パラメータ1行。Daiki決定後に decided_* を埋める。
CREATE TABLE IF NOT EXISTS calibration_reports (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                 TEXT NOT NULL,
  parameter              TEXT NOT NULL,       -- 'serp_overlap_n' | 'cosine_threshold' | 'density_gap' | 'salience_cutoff'
  evidence_json          TEXT NOT NULL,       -- histogram / ROC points / inflection 等
  candidates_json        TEXT NOT NULL,       -- [{value, rationale}, ...]
  recommended_value_json TEXT,                -- harness が示す推奨1案（Daikiが上書き可）
  decided_value_json     TEXT,                -- Daiki確定値（config凍結時に同期）
  decided_at             INTEGER,
  decided_by             TEXT,
  generated_at           INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  UNIQUE(run_id, parameter)
);

-- [B] 領域境界決定: 3信号の出力（和集合がインベントリ素材）
CREATE TABLE IF NOT EXISTS boundary_signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  signal_kind     TEXT NOT NULL,            -- 'serp' | 'density' | 'graph'
  entity_key      TEXT NOT NULL,            -- normalized entity name OR mid
  entity_name     TEXT NOT NULL,
  mid             TEXT,
  score           REAL,                     -- signal-specific (salience / cosine等)
  source_meta_json TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_boundary_run ON boundary_signals(run_id, signal_kind);
CREATE INDEX IF NOT EXISTS idx_boundary_key ON boundary_signals(run_id, entity_key);

-- 過剰拡張ガード: 他サイロの中心に近いため除外したエンティティ
CREATE TABLE IF NOT EXISTS boundary_exclusions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  entity_key      TEXT NOT NULL,
  entity_name     TEXT NOT NULL,
  reason          TEXT NOT NULL,
  meta_json       TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_excl_run ON boundary_exclusions(run_id);

-- [INV] 最終インベントリ（境界内・recall最大の和集合・重複排除）
CREATE TABLE IF NOT EXISTS inventory_entities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  entity_key      TEXT NOT NULL,
  entity_name     TEXT NOT NULL,
  mid             TEXT,
  signals_json    TEXT NOT NULL,            -- ['serp','density','graph']のうち寄与した信号
  score           REAL,                     -- 集約スコア
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(run_id, entity_key),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_inv_run ON inventory_entities(run_id);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0.3.0');
