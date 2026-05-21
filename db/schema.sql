-- =============================================================
-- Silo Coverage Designer — DB schema (Phase 1 baseline)
-- =============================================================
-- ⚠ しきい値・パラメータは全て config テーブル経由。コードに数値を埋めない。
-- ⚠ 共有データ層 (voyage-cache.db / serp-cache.db) は別ファイル。本DBは KW専有。

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- -------------------------------------------------------------
-- schema_migrations: 適用済みマイグレーションを記録
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- -------------------------------------------------------------
-- config: しきい値・予算・モード設定（versioned, audit対象）
--   key 例: 'L3.cosine_threshold', 'B.density_gap_min', 'AHREFS.unit_budget_monthly'
--   value は JSON 文字列（数値も "0.80" のように JSON）
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config (
  key         TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  value_json  TEXT NOT NULL,
  note        TEXT,
  set_by      TEXT,         -- 'system' | 'daiki' | 'calibration'
  set_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  is_current  INTEGER NOT NULL DEFAULT 1,    -- 1=現行, 0=履歴
  PRIMARY KEY (key, version)
);
CREATE INDEX IF NOT EXISTS idx_config_key_current ON config(key) WHERE is_current=1;

-- -------------------------------------------------------------
-- master_audit_log: 状態昇格・しきい値変更・コンプラ判定など全痕跡
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  actor        TEXT NOT NULL,        -- 'system' | 'daiki' | 'claude-code'
  event_type   TEXT NOT NULL,        -- 'config.update' | 'run.create' | 'l1.fetch' | 'compliance.flag' | ...
  entity_type  TEXT,                 -- 'config' | 'run' | 'candidate' | ...
  entity_id    TEXT,
  before_json  TEXT,
  after_json   TEXT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_event ON master_audit_log(event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON master_audit_log(entity_type, entity_id);

-- -------------------------------------------------------------
-- master_rules: ルール集（包含/除外、コンプラ判定基準、語彙正規化、サイロ間排出 等）
--   ルール本体はJSONで保持（後段が解釈）
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_rules (
  rule_id     TEXT PRIMARY KEY,
  rule_kind   TEXT NOT NULL,         -- 'exclusion' | 'normalization' | 'silo_eviction' | 'compliance_check' | ...
  vertical    TEXT,                  -- 'medical' | 'finance' | NULL=all
  body_json   TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_rules_kind ON master_rules(rule_kind);
CREATE INDEX IF NOT EXISTS idx_rules_vertical ON master_rules(vertical) WHERE vertical IS NOT NULL;

-- -------------------------------------------------------------
-- master_completeness_checklist: 真=美ゲートとコンプラ・フロアの必須項目
--   medical/AGAなど vertical別に展開。法令引用は条文・公的URLが空欄=要TODO
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_completeness_checklist (
  item_id       TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,       -- 'compliance_floor' | 'true_beauty_gate'
  vertical      TEXT,                -- 'medical' | NULL=all
  title         TEXT NOT NULL,
  description   TEXT,
  legal_basis   TEXT,                -- 法令・ガイドライン名（要確認の場合は 'TODO:要確認'）
  source_url    TEXT,                -- 公的URL（未確認の場合 NULL）
  severity      TEXT NOT NULL DEFAULT 'required', -- 'required' | 'recommended'
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_checklist_scope ON master_completeness_checklist(scope, vertical);

-- -------------------------------------------------------------
-- master_annotations: Daiki/オペレータの注釈、レビュー結果、判断ゲートの記録
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_annotations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type   TEXT NOT NULL,       -- 'run' | 'candidate' | 'cluster' | 'page' | 'config'
  target_id     TEXT NOT NULL,
  author        TEXT NOT NULL,       -- 'daiki' | 'claude-code' | 'system'
  kind          TEXT NOT NULL,       -- 'review' | 'gate_decision' | 'label' | 'note'
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_annotations_target ON master_annotations(target_type, target_id);

-- -------------------------------------------------------------
-- runs: 1 実行 = 1 seed × mode 設定。冪等再実行のための基準
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,    -- ULID/uuid
  seed_kw       TEXT NOT NULL,
  target        TEXT NOT NULL,       -- 'traditional' | 'geo' | 'both'
  scope         TEXT NOT NULL,       -- 'page' | 'cluster' | 'full_silo'
  site_mode     TEXT NOT NULL,       -- 'greenfield' | 'existing'
  vertical      TEXT,                -- 'medical' | NULL
  existing_urls_json TEXT,
  status        TEXT NOT NULL DEFAULT 'created',  -- created|l1|l2|b|inv|l3|nec|cov|diff|l4|l5|l6|done|failed
  config_snapshot_json TEXT,         -- 実行時の現行 config を凍結
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_seed ON runs(seed_kw, created_at);

-- -------------------------------------------------------------
-- l1_source_events: [L1] 各ソースから取得した生データ（不変・audit用）
--   provider: 'gsc' | 'llm_fanout' | 'serpapi_paa' | 'serpapi_related' | 'serpapi_autocomplete' | 'google_nlp'
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS l1_source_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  provider      TEXT NOT NULL,
  input_query   TEXT,                 -- 何を打ったか（fanoutでは seed、PAAでは打ったクエリ）
  raw_json      TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l1_events_run ON l1_source_events(run_id, provider);

-- -------------------------------------------------------------
-- l1_candidates: [L1] で生成された候補KW（出所タグ付き・重複は同一行に集約）
--   1 (run_id, keyword_norm) = 1行。出所は sources_json に配列で重畳
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS l1_candidates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  keyword         TEXT NOT NULL,        -- 表示用（取得時の表記）
  keyword_norm    TEXT NOT NULL,        -- 正規化キー（unicode NFKC + 小文字 + 全角半角整理 + 連続空白圧縮）
  sources_json    TEXT NOT NULL,        -- e.g. [{"provider":"gsc","meta":{...}}, {"provider":"serpapi_paa", ...}]
  first_seen_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(run_id, keyword_norm),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l1_candidates_run ON l1_candidates(run_id);

-- -------------------------------------------------------------
-- l1_entities: [L1] Google NLP で抽出された seed/関連クエリのエンティティ
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS l1_entities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  source_query    TEXT NOT NULL,        -- どのテキストから抽出したか
  name            TEXT NOT NULL,
  type            TEXT,                 -- NLP type
  mid             TEXT,                 -- Knowledge Graph MID（あれば）
  wikipedia_url   TEXT,
  salience        REAL,
  meta_json       TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_l1_entities_run ON l1_entities(run_id);
CREATE INDEX IF NOT EXISTS idx_l1_entities_mid ON l1_entities(mid) WHERE mid IS NOT NULL;

-- -------------------------------------------------------------
-- ahrefs_usage: ユニット消費のリアルタイム集計（[L2]で使用）
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ahrefs_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT,
  endpoint        TEXT NOT NULL,
  units_estimated INTEGER NOT NULL,
  units_actual    INTEGER,
  request_json    TEXT,
  response_meta_json TEXT,
  called_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_ahrefs_usage_run ON ahrefs_usage(run_id, called_at);
