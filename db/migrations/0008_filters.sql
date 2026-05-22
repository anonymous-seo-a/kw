-- Migration 0008: 候補KW の意図フィルタ
-- 「SEO記事化しないKW」(forum/Q&A/掲示板/競合brand) をマークして L3 / COV から除外。
-- inventory には残す (出し切り担保)。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS candidate_filters (
  run_id        TEXT NOT NULL,
  candidate_id  INTEGER NOT NULL,
  filter_kind   TEXT NOT NULL,    -- 'forum_qa' | 'brand_bleed' | future
  pattern       TEXT,             -- どのpatternにmatchしたか
  reason        TEXT,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (run_id, candidate_id, filter_kind),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cand_filters_run ON candidate_filters(run_id);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0.8.0');
