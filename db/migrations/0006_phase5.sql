-- Migration 0006: Phase 5 — [DIFF] + [L4]階層 + [L5]内部リンク + PageRank

PRAGMA foreign_keys = ON;

-- [DIFF] greenfield/existing 突合 (v1=greenfield: 全て new・existingはI/Fのみ)
CREATE TABLE IF NOT EXISTS diff_pages (
  run_id          TEXT NOT NULL,
  page_id         TEXT NOT NULL,
  mode            TEXT NOT NULL,                   -- 'greenfield' | 'existing'
  status          TEXT NOT NULL,                   -- 'new' (greenfield固定) | 'updated' | 'covered' | 'over' (existing用)
  existing_url    TEXT,                            -- existingモード時の既存URL (将来用)
  rationale       TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, page_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

-- [L4] 意図3層 (顕在/潜在/安心): page毎にClaude分類
CREATE TABLE IF NOT EXISTS l4_intent_layers (
  run_id          TEXT NOT NULL,
  page_id         TEXT NOT NULL,
  layer           TEXT NOT NULL,                   -- 'manifest' (顕在) | 'latent' (潜在) | 'reassurance' (安心)
  confidence      REAL,
  rationale       TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, page_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

-- [L4] 階層: hub/spoke tree (page → parent_page)
CREATE TABLE IF NOT EXISTS l4_hierarchy (
  run_id          TEXT NOT NULL,
  page_id         TEXT NOT NULL,
  parent_page_id  TEXT,                            -- NULL = silo ROOT
  depth           INTEGER NOT NULL,                -- 0=ROOT, 1=axis hub, 2=leaf
  edge_type       TEXT NOT NULL,                   -- 'root' | 'axis_hub' | 'spoke'
  cosine_to_parent REAL,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, page_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l4_parent ON l4_hierarchy(run_id, parent_page_id);

-- [L5] 内部リンク (有向グラフ)
CREATE TABLE IF NOT EXISTS l5_links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  source_page_id  TEXT NOT NULL,
  target_page_id  TEXT NOT NULL,
  link_type       TEXT NOT NULL,                   -- 'structural' (L4由来) | 'contextual' (cosineブリッジ) | 'axis_cross' (軸横断)
  weight          REAL NOT NULL,                   -- 0..1
  rationale       TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (run_id, source_page_id, target_page_id, link_type),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l5_links_src ON l5_links(run_id, source_page_id);
CREATE INDEX IF NOT EXISTS idx_l5_links_tgt ON l5_links(run_id, target_page_id);

-- PageRank
CREATE TABLE IF NOT EXISTS l5_pagerank (
  run_id          TEXT NOT NULL,
  page_id         TEXT NOT NULL,
  score           REAL NOT NULL,
  iterations      INTEGER NOT NULL,
  computed_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, page_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0.6.0');
