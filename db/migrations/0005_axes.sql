-- Migration 0005: [AX] Modifier 軸分類 (仕様 §4 rev 2026-05-22-2)
--
-- 各候補KWに 0..n の modifier 軸を付与する:
--   - 0軸  → 'core' バケット (純粋なintent。例: "aga 治療", "aga おすすめ")
--   - 1軸  → その軸バケット (例: location/'東京', cost/'保険適用')
--   - 2+軸 → 多軸bridge (NEC で passage_absorbed 候補)
--
-- 軸 enum:
--   'core'          ← 1軸KWで pure intent 表現 (他に modifier 無し)
--   'location'      ← 地域 (東京/大阪/福岡/横浜/上野/...)
--   'cost'          ← コスト/保険 (保険適用/安い/料金/相場/費用/高い)
--   'drug'          ← 薬剤名 (フィナステリド/ミノキシジル/プロペシア/...)
--   'audience'      ← 性別/年齢 (女性/男性/20代/メンズ/...)
--   'format'        ← 形態 (オンライン/皮膚科/専門/総合/...)
--   'condition'     ← サブ症状 (M字/初期/進行/手遅れ/効果ない/...)
--   'trust'         ← 信頼性 (口コミ/評判/知恵袋/比較/ランキング/...)
--   'informational' ← 情報系 (とは/原因/仕組み/予防/遺伝/治る/...)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS candidate_axes (
  candidate_id    INTEGER NOT NULL,
  axis            TEXT NOT NULL,                  -- 軸名 (上記enum)
  axis_value      TEXT NOT NULL DEFAULT '',        -- 軸の具体値 (core は '')
  confidence      REAL,                            -- Claudeの自信度 0..1
  source          TEXT NOT NULL DEFAULT 'claude',  -- 'claude' | 'rule' | 'manual'
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (candidate_id, axis, axis_value),
  FOREIGN KEY (candidate_id) REFERENCES l1_candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_axes_axis ON candidate_axes(axis, axis_value);
CREATE INDEX IF NOT EXISTS idx_axes_cand ON candidate_axes(candidate_id);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0.5.0');
