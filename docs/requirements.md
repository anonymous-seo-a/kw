# 要件定義：サイロ被覆設計ツール（Silo Coverage Designer）

最終更新: 2026年5月21日
対象実装者: Claude Code
最終承認者: Daiki
本書の位置づけ: Web版Claude（設計）→ 本要件定義 → Claude Code（実装・検証）→ Daiki（承認・本番投入）

---

## 0. 目的

トップKW 1語から、**SEO上位獲得に必要なエンティティ領域を、最小限の構造で過不足なく被覆する**KW設計を自動出力する。

形式: **境界づけられたエンティティ領域に対する最小被覆問題（minimum set cover）**。

- 「全て埋める」= エンティティ・インベントリ層（recall最大・取りこぼし0）
- 「最小限」= ページ構造層（全エンティティを被覆する最小ページ数）
- ページに値しないエンティティ = 既存/他ページのパッセージに吸収

得点関数 = **両取り**（従来型1位 ＋ GEO/AI引用）。衝突時は従来型を優先重み付け。

---

## 1. 動作モードとパイロット

| | v1（今回） | 将来 |
|---|---|---|
| サイト | greenfield（新規） | existing（既存・足りないKW抽出） |
| [DIFF]段 | 不足=最小被覆の全ページ（全て新規）/ 過剰・充足=N/A | 不足/過剰/充足のフル差分 |
| コアエンジン [L0]〜[COV] | 共通（site-agnostic） | 共通 |

- パイロットseed: **「AGA おすすめ」**（商業ルート＝hubに収益ページ、情報spokeが収束）
- 垂直: 医療・健康YMYL（最厳格）→ §6 コンプライアンス・フロア必須

---

## 2. システム構成・デプロイ

```
独立ツール（own repo / own subdomain / own UI）
  ＋ cannibalization-system と同一VPSに同居
  ＋ 【共有データ層】← 重複排除（閉合性）
      ├ Voyage embedding ストア（voyage-3-large / 1024次元）
      └ SERP キャッシュ
```

- 将来のexistingモードの「過剰検出」は cannibalization-system の機能を呼び出す（再実装しない）
- 技術スタック（既存s-tools/カニバリ系から流用）:
  - Node.js + TypeScript
  - better-sqlite3（master tables / audit log）
  - React + Vite（ダッシュボード）
  - Express
  - Claude API（fan-out模擬・intent分類・コンプライアンス判定）
- repo名・subdomain名はDaiki確定（例: `silo-designer` / `silo.anonymous-seo.jp` 等）

---

## 3. パイプライン全体

```
INPUT: seed KW（例: "AGA おすすめ"）＋ mode設定
  │
[L0]  対象定義 ── target=両取り / scope=サイロ全体 / site=greenfield / vertical=medical
  │
[L1]  候補生成 ── 多ソースで広く張る（Ahrefsも統合・予算ガード経由）
  ├ GSC実クエリ（無料）
  ├ LLMファンアウト模擬（Google AI Modeのサブクエリ8〜20本を再現）
  ├ SerpAPI（PAA・サジェスト・関連検索）
  ├ エンティティ展開（Google NLP API → Knowledge Graph → 派生クエリ）
  └ Ahrefs Keywords Explorer (matching/related/questions/suggestions) ※rev 2026-05-22
  │
[L2]  エンリッチ ── 絞り込み後にAhrefs精密（§5 ユニット予算）
  ├ volume / KD / CPC / intent（Ahrefs）
  ├ embedding（Voyage・共有層）
  ├ entity salience + MID（Google NLP）
  └ SERPフィンガープリント（各KW上位10URL・SerpAPI）
  │
[B]   領域境界決定 ── §4
  │
[INV] エンティティ・インベントリ ── 境界内・recall最大で全列挙
  │
[L3]  SERPクラスタリング ── 上位重複≥3（Koray法）∩ cosine類似 → ページ単位候補
  │
[NEC] 必然性フィルタ ── 順位/引用を生むか / No→パッセージ吸収
  │                     ＋ vertical=medical時 コンプライアンス・フロア付与（§6）
[COV] 最小被覆 ── 全インベントリ・エンティティを最小ページ数で被覆（set cover）
  │
[DIFF]既存URL突合 ── mode切替（greenfield: 全て不足=新規 / existing: フル差分）
  │
[L4]  階層割付 ── centroid hub ＋ entity親子 ＋ 意図3層（顕在/潜在/安心）
  │
[L5]  内部リンク ── contextual bridge ＋ PageRankフロー模擬
  │
[L6]  真=美ゲート ── §8
  │
OUTPUT: §7
```

過去2年に存在しなかった新規実装は **[L1]ファンアウト模擬** と **[B]領域境界決定** の2点。残りは流用または既知手法。

---

## 4. [B] 領域境界決定（核心）

「その語に類する全ナレッジ」の境界を3信号の和集合で切り、過剰拡張をガードする。

```
領域 = SERP由来 ∪ embedding密度 ∪ エンティティグラフ

[SERP由来]      in-rangeクエリの上位ページに出現するエンティティ集合
                → 必然性フロア（競合に並ぶ下限・必ず埋める）
[embedding密度]  seed centroidからのcosineが密度ギャップを超えるまで
                → 幾何的な領域の縁
[エンティティグラフ] seedエンティティからKnowledge Graphをsalience減衰
                  しきい値までNホップ
                → 競合未取得エンティティ＝独自性の天井

過剰拡張ガード:
  他seedの領域でより中心的（=他centroidに近い）なエンティティは
  本サイロから除外し、当該サイロへ排出（サイロ間カニバリ防止）
```

**両取りの担保**:
- 必然性フロア（SERP由来）→ 従来型1位の下限
- フロア超え（density/graph拡張）→ 独自性（従来型上振れ）∩ fan-out被覆（AI引用）
- 「両取り」は別作業ではなく、フロア＋拡張の一本道で達成

**包含ポリシー（確定済み・⑦）**: 非対称設計。
- インベントリ = 和集合（recall優先・漏らさない）
- ページ化 = 必然性ゲート（[NEC]で絞る）

### 校正プロトコル（AGAサイロ実データで実測）

しきい値はサイロ依存。パイロットで以下を校正し、master tableに記録:

| パラメータ | 校正方法 | 初期値（仮） |
|---|---|---|
| SERP重複N | 「AGA おすすめ」周辺クエリペアのSERP一致率分布を見て、同一ページ運用が妥当な閾を決定 | 3 |
| cosineしきい値 | 同一/別クラスタの正解例を数十ペア手動ラベル → ROCで決定 | 0.80前後（要実測） |
| 密度ギャップ | seed centroidからの距離ヒストグラムの谷 | データ依存 |
| graphホップ/salience cutoff | Nホップ先のエンティティが上位記事に出現する割合が閾を切る点 | salience 0.01前後（要実測） |

初期値は仮。**実測で確定し、Daikiが真=美ゲートで承認するまで本番に出さない。**

---

## 5. データソースとユニット予算

| ソース | 役割 | コスト/制約 |
|---|---|---|
| GSC API（service account） | 実クエリ・実順位（一次データ） | 無料 |
| Ahrefs GSC keywordsエンドポイント | 実クリック/impression | 無料・ユニット消費0 |
| Ahrefs Keywords Explorer等 | volume/KD/intent確定値 | **要ユニット**。最小50/req、行数×フィールドで増加 |
| SerpAPI | SERPフィンガープリント・PAA | 既存契約 |
| Google NLP API | エンティティ抽出・salience・MID | 従量 |
| Voyage（voyage-3-large） | embedding | 共有層・既存 |
| Claude API | fan-out模擬・intent・コンプラ判定 | 従量 |

**ユニット運用方針** (rev 2026-05-22): Ahrefsを**[L1]の候補生成にも統合**する。Google単一ソース依存を解消し、ブランド名/地域/情報系などのdimensionを Ahrefs サジェストで拾うため。
- [L1] では `matching-terms` / `related-terms` / `matching-terms?terms=questions` / `search-suggestions` の4エンドポイントを seed に対して呼ぶ (1 seed ≒ 8,000ユニット見込み)
- [L2] では確定対象に volume/KD/CPC/intent を当てる (大量消費は引き続き [L3] 生存後)
- 全コールは `ahrefs_budget` (config `ahrefs_unit_budget_monthly` ・既定 150,000/月) で `assertAvailable()` → `consume()` を通し、超過で自動停止
- Standardプラン想定で **月10〜30 seed** 規模感を維持（[L1] 8k + [L2] 1-3k ≒ 1 seed あたり <15kユニット）

---

## 6. AGA垂直の必然性フロア（コンプライアンス・フロア）

vertical=medical検知時、[NEC]が以下を**volume非依存の必須エンティティ**として自動付与。未充足は「不足」の最優先フラグ（順位以前に掲載資格の問題）。

| 必須要素 | 根拠（実装時に該当条文・公的URLを確認） |
|---|---|
| 医療広告ガイドライン遵守（8広告禁止事項：比較優良・誇大・体験談・ビフォーアフター等の制約） | 厚生労働省「医療広告ガイドライン」 |
| PR/広告関係の明示（ステマ規制） | 消費者庁 景品表示法・ステマ規制告示（2023年10月施行） |
| 優良誤認・有利誤認の回避、料金は税込総額表示 | 消費者庁 景表法 / 国税庁 総額表示義務 |
| 医学的主張の権威ソース引用 | 日本皮膚科学会「男性型脱毛症診療ガイドライン」 |
| 医師監修の明示（編集方針・監修者情報） | E-E-A-T（Experience/Expertise/Authoritativeness/Trust） |
| 副作用・リスクの明示 | 厚労省 医薬品安全性情報 等 |
| 薬剤（フィナステリド/デュタステリド/ミノキシジル等）の効能表現の薬機法整合 | 医薬品医療機器等法（薬機法） |

**実装注意**: 上記は法令・公的ガイドラインの正確な引用を要する（条文番号・公的URLを実装時に必ず確認。本書では未確定）。Claude APIによるコンプラ判定は「フラグ提示」までとし、最終可否はDaiki判断。

---

## 7. 入出力スキーマ

### INPUT
```yaml
seed_kw: "AGA おすすめ"
target: both            # traditional | geo | both
scope: full_silo        # page | cluster | full_silo
site_mode: greenfield   # greenfield | existing
vertical: medical       # コンプライアンス・フロア起動トリガ
existing_urls: null     # existingモード時のみ（突合対象）
```

### OUTPUT（4成果物）
```
① DIFF表       : kw → cluster_id → page → 意図層 → metrics → action(新規/統合/維持) → compliance_flag
② topical map  : hub/spoke ツリー（core_map / outer_map）
③ 内部リンクグラフ: 有向エッジ（source→target, anchor_context, bridge_type）
④ ページ別パッセージ仕様: {primary_cluster, owned_entities, fan-out_subqueries(=パッセージ), 
                          supporting_entities(co-occurrence用), compliance_required[]}
```

④は knowledge_04 執筆指示書の**構成層・実行層にそのまま流し込める粒度**で出力。
これが「1クラスタ1ページ（最小性=従来型）× ページ内fan-outパッセージ網羅（最大性=GEO）」を同時充足する出力単位。

### ダッシュボード（cannibalization系の5タブ思想を流用）
- UMAP散布（意味分布・領域境界の可視化）
- ネットワークグラフ（内部リンク構造）
- Sankey（PageRankフロー）
- DIFF表（不足/過剰/充足）
- コンプラ・フロア充足チェックリスト

---

## 8. 真=美検証ゲート（[L6]）

| 真=美 | 具体テスト | 合格条件 |
|---|---|---|
| 必然性 | 各ページが他で被覆されない意図層を持つか | 冗長ページ0 |
| 閉合性 | クラスタ集合が対象得点関数のサブクエリを全被覆するか | インベントリ全エンティティがどこかに写像（被覆100%） |
| 最小性 | 2クラスタを統合しても被覆を失わないか | 統合可能ペア0 |
| 境界 | 領域がタイトか（過剰拡張ガード通過） | 他サイロ中心エンティティの混入0 |
| コンプラ（medical） | フロア要素が全て充足/フラグされているか | 未充足の必須要素0 |

最終承認はDaiki。校正値・境界・被覆の妥当性は人間判断で確定。

---

## 9. パイロット実行計画

1. seed「AGA おすすめ」で[L1]候補生成（無料ソースのみ）
2. [B]の4パラメータを§4校正プロトコルで実測・確定
3. [INV]→[L3]→[NEC]→[COV]を通し、最小被覆マップを生成
4. §6コンプラ・フロアの自動付与を検証
5. 出力4成果物をDaikiが真=美ゲートでレビュー
6. 校正値・しきい値をmaster tableに凍結
7. greenfieldモードで第1サイロ確定 → 以降のseedへ展開

---

## 10. 実装スコープ境界（やらないこと）

- Ahrefsを **予算ガード無し** で使う（必ず `ahrefs_budget` で `assertAvailable()` → `consume()`）※rev 2026-05-22 で [L1] 取込解禁、ただし予算管理は厳守
- embedding/SERPストアの二重保持（共有層を使う）
- コンプラ判定の最終可否をツールが下す（フラグ提示まで・判断はDaiki）
- 法令の曖昧引用（条文・公的URL未確認のまま出力しない）
- existingモードの過剰検出を再実装（cannibalization-systemを呼ぶ）
