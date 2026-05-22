-- Migration 0007: Phase 6 — [L6]真=美ゲート + 4成果物 export メタデータ

PRAGMA foreign_keys = ON;

-- 真=美 5項目自動チェック結果
CREATE TABLE IF NOT EXISTS l6_truebeauty_checks (
  run_id         TEXT NOT NULL,
  check_kind     TEXT NOT NULL,  -- 'necessity' | 'closure' | 'minimality' | 'boundary' | 'compliance'
  status         TEXT NOT NULL,  -- 'pass' | 'fail' | 'flag' (要Daiki判断)
  metric_json    TEXT NOT NULL,  -- 具体テストの数値・違反一覧
  rationale      TEXT,
  checked_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, check_kind),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

-- 4成果物 export メタデータ (実体はファイルシステムへ)
CREATE TABLE IF NOT EXISTS phase6_exports (
  run_id          TEXT NOT NULL,
  artifact        TEXT NOT NULL,         -- 'diff_table' | 'topical_map' | 'link_graph' | 'page_spec'
  file_path       TEXT NOT NULL,
  byte_size       INTEGER,
  row_count       INTEGER,
  generated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, artifact),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0.7.0');
