-- Shared Voyage embedding cache (file: /opt/shared/voyage-cache.db)
-- 仕様: content_hash + model + input_type をキーに embedding を一度だけ計算
-- ⚠ kw / cannibalization-system 双方が同じファイルを開く前提（better-sqlite3 + WAL）
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS voyage_embeddings (
  content_hash   TEXT NOT NULL,        -- SHA-256 of normalized input
  model          TEXT NOT NULL,        -- 'voyage-3-large'
  input_type     TEXT NOT NULL,        -- 'document' | 'query'
  dim            INTEGER NOT NULL,     -- 1024
  embedding      BLOB NOT NULL,        -- Float32Array LE buffer (dim*4 bytes)
  tokens         INTEGER,
  source_app     TEXT,                 -- 'kw' | 'cannibalization' (どちらが最初に書いたか)
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_used_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (content_hash, model, input_type)
);
CREATE INDEX IF NOT EXISTS idx_voyage_recent ON voyage_embeddings(last_used_at);
