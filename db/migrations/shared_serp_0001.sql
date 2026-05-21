-- Shared SERP cache (file: /opt/shared/serp-cache.db)
-- 仕様: SerpAPI のレスポンスを (engine, query, gl, hl, device, num) で正規化保存
-- TTL は呼出側で判断（取得時に created_at を比較）
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS serp_results (
  cache_key     TEXT PRIMARY KEY,           -- sha256 of canonical request params JSON
  engine        TEXT NOT NULL,              -- 'google' | 'google_autocomplete' | 'google_related' | ...
  query         TEXT NOT NULL,
  params_json   TEXT NOT NULL,              -- gl, hl, device, num, location, ...
  result_json   TEXT NOT NULL,              -- 生レスポンス
  result_url_count INTEGER,
  source_app    TEXT,                       -- 'kw' | 'cannibalization'
  fetched_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_serp_query ON serp_results(query, engine);
CREATE INDEX IF NOT EXISTS idx_serp_fetched ON serp_results(fetched_at);

-- 上位URL分解（[L2] SERPフィンガープリント／重複Nカウント用）
CREATE TABLE IF NOT EXISTS serp_top_urls (
  cache_key     TEXT NOT NULL,
  rank          INTEGER NOT NULL,
  url           TEXT NOT NULL,
  domain        TEXT,
  title         TEXT,
  PRIMARY KEY (cache_key, rank),
  FOREIGN KEY (cache_key) REFERENCES serp_results(cache_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_serp_url ON serp_top_urls(url);
CREATE INDEX IF NOT EXISTS idx_serp_domain ON serp_top_urls(domain);
