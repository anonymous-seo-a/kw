-- Migration 0010: spec-01 軸レイヤー・同一意図マージ・出力契約

PRAGMA foreign_keys = ON;

-- 修正A: theme (軸) レイヤー — SERP意図ファミリーで導出された少数 (8-12) themes
CREATE TABLE IF NOT EXISTS themes (
  run_id        TEXT NOT NULL,
  theme_id      TEXT NOT NULL,           -- 't_01' .. 't_12'
  theme_name    TEXT NOT NULL,           -- Claude命名 (例: "AGAクリニック総合", "オンライン診療", "地域別", ...)
  rationale     TEXT,
  page_count    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, theme_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

-- page→theme 関連
CREATE TABLE IF NOT EXISTS page_theme (
  run_id        TEXT NOT NULL,
  page_id       TEXT NOT NULL,
  theme_id      TEXT NOT NULL,
  PRIMARY KEY (run_id, page_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_page_theme_theme ON page_theme(run_id, theme_id);

-- 修正C: location 正規化 (表記ゆれ → canonical)
-- 候補KW投入時の axis_value を canonical に書き換える前の元値追跡。
CREATE TABLE IF NOT EXISTS location_normalization (
  run_id          TEXT NOT NULL,
  original_value  TEXT NOT NULL,
  canonical_value TEXT NOT NULL,        -- '新宿' 等
  kind            TEXT NOT NULL,        -- 'variant' (表記ゆれ) | '商圏統合' (親に吸収) | 'noise'
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, original_value),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

-- 修正B: cross-bucket SERP page merge log (audit / debug用)
CREATE TABLE IF NOT EXISTS page_serp_merges (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  from_cluster_id TEXT NOT NULL,
  into_cluster_id TEXT NOT NULL,
  overlap         INTEGER NOT NULL,
  bucket_from     TEXT,
  bucket_into     TEXT,
  rep_kw_from     TEXT,
  rep_kw_into     TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_page_merges_run ON page_serp_merges(run_id);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0.10.0');
