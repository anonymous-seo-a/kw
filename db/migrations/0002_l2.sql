-- Migration 0002: [L2] エンリッチ層
-- 各候補KWに vector / salience / SERPフィンガープリント / metrics を付与する。
-- Vector本体は共有Voyageキャッシュに存在し、ここは content_hash 参照のみ持つ（二重保持禁止）。
-- SERP top URL本体も shared.serp_top_urls に存在し、ここは cache_key 参照のみ。
-- l2_metrics は Phase 4 ([L3]生存後) で Ahrefs から埋める。Phase 2 では空作成のみ。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS l2_embeddings (
  candidate_id   INTEGER PRIMARY KEY,
  content_hash   TEXT NOT NULL,                  -- shared voyage_embeddings.content_hash
  model          TEXT NOT NULL,                  -- 'voyage-3-large'
  dim            INTEGER NOT NULL,               -- 1024
  input_type     TEXT NOT NULL,                  -- 'document' | 'query'
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (candidate_id) REFERENCES l1_candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l2_emb_hash ON l2_embeddings(content_hash);

CREATE TABLE IF NOT EXISTS l2_entities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id    INTEGER NOT NULL,
  name            TEXT NOT NULL,
  type            TEXT,
  mid             TEXT,
  wikipedia_url   TEXT,
  salience        REAL NOT NULL,
  meta_json       TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (candidate_id) REFERENCES l1_candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l2_ent_cand ON l2_entities(candidate_id);
CREATE INDEX IF NOT EXISTS idx_l2_ent_mid ON l2_entities(mid) WHERE mid IS NOT NULL;

-- 候補KW → SerpAPI cache_key 対応（top URLは shared.serp_top_urls にあり）
CREATE TABLE IF NOT EXISTS l2_serp_fp (
  candidate_id    INTEGER PRIMARY KEY,
  cache_key       TEXT NOT NULL,                 -- shared.serp_results.cache_key
  top_n           INTEGER NOT NULL,              -- 取得できた件数（≤10）
  fetched_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (candidate_id) REFERENCES l1_candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l2_serp_key ON l2_serp_fp(cache_key);

-- Phase 4 ([L3]生存後) で Ahrefs から埋める
CREATE TABLE IF NOT EXISTS l2_metrics (
  candidate_id      INTEGER PRIMARY KEY,
  volume            INTEGER,
  kd                REAL,
  cpc               REAL,
  intent            TEXT,
  ahrefs_fetched_at INTEGER,
  FOREIGN KEY (candidate_id) REFERENCES l1_candidates(id) ON DELETE CASCADE
);

-- 月次ユニット予算カウンタ（ahrefs_usage と合わせて確認する）
CREATE TABLE IF NOT EXISTS ahrefs_budget (
  month_yyyymm    TEXT PRIMARY KEY,              -- 'YYYYMM' UTC
  budgeted_units  INTEGER NOT NULL,
  consumed_units  INTEGER NOT NULL DEFAULT 0,
  last_updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0.2.0');
