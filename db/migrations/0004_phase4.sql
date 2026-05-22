-- Migration 0004: Phase 4 — [L3]クラスタ + [NEC]必然性 + コンプラ・フロア + [COV]最小被覆

PRAGMA foreign_keys = ON;

-- [L3] SERPクラスタリング: (SERP重複≥N) ∩ (cosine≥T) を辺としてunion-find→連結成分
CREATE TABLE IF NOT EXISTS l3_clusters (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             TEXT NOT NULL,
  cluster_id         TEXT NOT NULL,          -- 'c_0001' 等
  representative_kw  TEXT,
  size               INTEGER NOT NULL,
  metric_json        TEXT,                   -- 平均cosine, 平均overlap等
  status             TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'absorbed'
  absorbed_into      TEXT,
  created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(run_id, cluster_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l3_clu_run ON l3_clusters(run_id);

CREATE TABLE IF NOT EXISTS l3_cluster_members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  cluster_id      TEXT NOT NULL,
  candidate_id    INTEGER NOT NULL,
  is_representative INTEGER NOT NULL DEFAULT 0,
  UNIQUE(run_id, cluster_id, candidate_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l3_mem_cluster ON l3_cluster_members(run_id, cluster_id);
CREATE INDEX IF NOT EXISTS idx_l3_mem_cand ON l3_cluster_members(candidate_id);

-- [NEC] 必然性判定: page or passage_absorbed
CREATE TABLE IF NOT EXISTS nec_decisions (
  run_id          TEXT NOT NULL,
  cluster_id      TEXT NOT NULL,
  decision        TEXT NOT NULL,            -- 'page' | 'passage_absorbed'
  reason          TEXT,
  absorbed_into   TEXT,                     -- decision='passage_absorbed' のとき
  decided_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, cluster_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

-- コンプラ・フロア: vertical=medical 時に seed JSON から自動付与
CREATE TABLE IF NOT EXISTS compliance_floor_items (
  run_id              TEXT NOT NULL,
  item_id             TEXT NOT NULL,        -- seed JSONのidをそのまま
  title               TEXT NOT NULL,
  issuer              TEXT,
  law_or_doc_name     TEXT,
  article             TEXT,
  source_url          TEXT,
  related_urls_json   TEXT,
  last_revised        TEXT,
  severity            TEXT NOT NULL DEFAULT 'required',
  verification_needed INTEGER NOT NULL DEFAULT 0,  -- 1なら TODO:要確認 を出力に出す
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'covered' | 'missing'
  covered_by_page_id  TEXT,
  created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, item_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_compl_run ON compliance_floor_items(run_id, status);

-- [COV] 最小被覆: ページ単位 (= L3クラスタ where NEC='page')
CREATE TABLE IF NOT EXISTS cov_pages (
  run_id        TEXT NOT NULL,
  page_id       TEXT NOT NULL,             -- 'p_0001'
  cluster_id    TEXT NOT NULL,
  title_hint    TEXT,
  covers_json   TEXT NOT NULL,             -- [entity_key, ...]
  cover_size    INTEGER NOT NULL,
  pick_order    INTEGER NOT NULL,           -- greedy pickの順番 (1=最初)
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, page_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cov_pages_run ON cov_pages(run_id);

CREATE TABLE IF NOT EXISTS cov_assignments (
  run_id        TEXT NOT NULL,
  entity_key    TEXT NOT NULL,
  page_id       TEXT,                       -- NULLなら uncovered
  PRIMARY KEY (run_id, entity_key),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cov_assign_page ON cov_assignments(run_id, page_id);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0.4.0');
