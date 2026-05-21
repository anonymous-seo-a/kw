# 開発指示書：kw.anonymous-seo.jp（Silo Coverage Designer）

宛先: Claude Code
仕様（WHAT）: `silo-coverage-designer-requirements.md` ← **本書より優先。先に必読**
本書（HOW）: ビルド計画・手順・判断ゲート
役割分担: Claude Code＝実装・検証・サブドメインへのデプロイ / Daiki＝判断ゲート承認・校正凍結・本番go判断

---

## 0. 厳守事項（最初に読むこと）

1. **まず仕様書を読む**: `silo-coverage-designer-requirements.md` が唯一の仕様。本書はその実装計画。
2. **憶測せず inspect する**: デプロイ・インフラ構成は**同一VPSに同居する cannibalization-system の実構成をSSHで読み、踏襲する**。サーバ構成・Webサーバ・プロセス管理・Node版・DB配置・env管理を自分で決めない。
3. **判断ゲートで必ず止まる**: 以下はDaikiの専管。Claude Codeは案を提示して停止し、自動確定しない。
   - 校正値（cosine / SERP重複N / 密度ギャップ / graphホップ・salience cutoff）
   - コンプライアンス・フロアの可否（フラグ提示まで）
   - 領域境界の最終確定
   - 真=美ゲートの合否
4. **制約（やらないこと）**:
   - Ahrefsを[L1]拡張で使う（ユニット浪費・禁止。Ahrefsは[L2]の絞り込み後のみ）
   - embedding/SERPストアの二重保持（共有データ層を使う）
   - しきい値のハードコード（全てconfig駆動・config tableに保存）
   - コンプラ/真=美の最終可否をツールが下す（フラグ提示のみ）
   - 法令の曖昧引用（条文・公的URL未確認のまま出力しない。`TODO:要確認`で明示）
5. **作業様式**: featureブランチ、フェーズ単位の小さなコミット、各フェーズ末に自己検証結果を報告。

---

## 1. インフラ前提

| 項目 | 状態 |
|---|---|
| サブドメイン | `kw.anonymous-seo.jp`（取得済・同一サーバなので紐付け容易） |
| VPS | SSH接続可（cannibalization-system と同一サーバ） |
| 共有データ層 | Voyage embeddingストア（voyage-3-large/1024次元）＋ SERPキャッシュ（cannibalization-systemが保持） |
| 既存外部API疎通 | cannibalization-systemで実績あり（VPSからの外部API到達は実証済みと推定→Phase0で確認） |
| repo | `anonymous-seo-a/kw`（作成済・空・**public**）。public運用なら secrets/env/DB/*.sqlite の `.gitignore` 必須＋secret scanning有効化（誤コミットは即露出） |

---

## 2. Phase 0：インフラ把握とスキャフォールド（最初の作業）

**目的**: 構成を inspect し、足場を提示してゲートに回す。機能コードはまだ書かない。

**作業**:
1. SSHでVPSに接続し、cannibalization-system の構成を読む:
   - Webサーバ（nginx/apache等）と vhost/リバースプロキシ設定
   - プロセス管理（PM2/systemd/docker等）
   - Node.jsバージョン、パッケージ管理
   - DB（better-sqlite3ファイルの配置）
   - env/secrets管理方式
   - 共有データ層（Voyage embeddingストア・SERPキャッシュ）の所在とアクセス方法
2. repo `anonymous-seo-a/kw`（作成済・空）にゼロからスキャフォールド。スタックは要件定義§2準拠（Node.js+TypeScript / better-sqlite3 / React+Vite / Express / Claude API）。**最初のコミット前に `.gitignore`** を整備（env / secrets / *.sqlite / DBファイル / node_modules）。
3. `kw.anonymous-seo.jp` の紐付け方針を、同居ツールの vhost パターンに合わせて立案。
4. secrets雛形（env）: 既存キー流用（Voyage）＋追加（GSC service account / SerpAPI / Ahrefs token / Google NLP / Claude API）。**ハードコード禁止**。
5. VPSからの外部API到達を疎通確認（Voyage/Ahrefs/Google NLP/SerpAPI/Claude）。

**受け入れ基準**: インフラ構成マップ＋repo雛形＋subdomain紐付け方針＋疎通結果。

**🚦Daikiゲート**: 上記提示 → 承認後にPhase 1へ。

---

## 3. ビルド・フェーズ（垂直スライス）

各フェーズ: 実装 → 自己検証 → 報告 → 🚦ゲート（必要な場合）。仕様の各レイヤーは要件定義§3〜§8に対応。

### Phase 1：データ背骨 ＋ [L1]候補生成
- **実装**: master tables（annotations / rules / completeness checklist / audit log）＋ config table（しきい値格納用・空でよい）。[L1]を無料ソースのみで実装（GSC実クエリ / LLMファンアウト模擬8〜20本 / SerpAPI PAA・サジェスト / Google NLPエンティティ展開）。
- **受け入れ**: seed「AGA おすすめ」で候補KW＋出所タグ付きリストが出る。Ahrefs不使用を確認。
- ゲート: 不要（次へ）。

### Phase 2：[L2]エンリッチ ＋ ユニット予算ガード
- **実装**: 共有Voyageストアでembedding取得（二重保持禁止）。entity salience+MID（Google NLP）。SERPフィンガープリント（SerpAPI・上位10URL）。**Ahrefsは[L3]クラスタ生存後の確定対象にのみ**当てる。ユニット消費の事前見積り＋上限ガード（超過時は停止して報告）。
- **受け入れ**: 各KWにvector/salience/SERP/metricsが付与。Ahrefsユニット消費ログが出る。
- ゲート: 不要。

### Phase 3：[B]領域境界 ＋ [INV]インベントリ ＋ **校正ハーネス**（重要ゲート）
- **実装**: 境界=SERP由来 ∪ embedding密度 ∪ エンティティグラフ ＋ 過剰拡張ガード（要件定義§4）。**全しきい値をconfig駆動**。校正ハーネスを実装:
  - cosine: 同一/別クラスタの手動ラベルペア → ROCで閾候補
  - SERP重複N: 周辺クエリペアのSERP一致率分布
  - 密度ギャップ: centroid距離ヒストグラムの谷
  - graphホップ/salience: Nホップ先エンティティの上位記事出現率
- **受け入れ**: 校正ハーネスがしきい値候補とその根拠（分布図・ROC）を出力。インベントリが和集合・recall最大で生成。
- **🚦Daikiゲート**: 校正値はClaude Codeが確定しない。候補と根拠を提示 → Daikiが値を決定 → config tableに凍結（audit log記録）。

### Phase 4：[L3]クラスタ ＋ [NEC]必然性 ＋ コンプラ・フロア ＋ [COV]最小被覆
- **実装**: SERP重複≥N ∩ cosine で[L3]クラスタリング → ページ単位候補。[NEC]必然性フィルタ（順位/引用を生むか、否→パッセージ吸収）。**vertical=medical検知時、コンプライアンス・フロアを自動付与**（要件定義§6）。法令引用は`TODO:要確認`で条文・公的URL欄を空けて明示。[COV]最小被覆（set cover）。
- **受け入れ**: 最小被覆マップ生成。コンプラ・フロア要素が必須として現れ、未充足が最優先フラグ化。
- **🚦Daikiゲート**: コンプラ・フロアの可否はフラグ提示まで。Daiki確認。

### Phase 5：[DIFF]（greenfield）＋ [L4]階層 ＋ [L5]内部リンク
- **実装**: [DIFF]はモード切替実装（v1=greenfield：全て不足＝新規 / existingは将来：過剰検出はcannibalization-systemを呼ぶ前提でI/Fだけ用意）。[L4]階層（centroid hub＋entity親子＋意図3層）。[L5]内部リンク（contextual bridge＋PageRankフロー模擬）。
- **受け入れ**: hub/spokeツリー＋有向リンクグラフ＋PageRankフロー分布が出る。
- ゲート: 不要。

### Phase 6：[L6]真=美ゲート ＋ 4成果物出力
- **実装**: 真=美ゲート（要件定義§8：必然性/閉合性/最小性/境界/コンプラの自動チェック→合否は提示）。出力4成果物（要件定義§7）: ①DIFF表 ②topical map ③内部リンクグラフ ④ページ別パッセージ仕様（執筆指示書の構成層・実行層粒度）。
- **受け入れ**: 4成果物がエクスポート可能（JSON＋人間可読）。真=美チェック結果が提示される。
- **🚦Daikiゲート**: 真=美ゲート合否はDaiki最終判断。

### Phase 7：ダッシュボード（React+Vite・5タブ）
- **実装**: UMAP散布（領域境界可視化）/ ネットワークグラフ（リンク）/ Sankey（PageRankフロー）/ DIFF表 / コンプラ・フロア充足チェックリスト。cannibalization-systemの5タブ思想を流用。
- **受け入れ**: ローカルで全タブ描画。
- ゲート: 不要。

### Phase 8：デプロイ（kw.anonymous-seo.jp）
- **実装**: Phase 0で読んだ同居ツールのパターンに合わせてデプロイ。subdomain紐付け、プロセス常駐、HTTPS。
- **受け入れ**: `https://kw.anonymous-seo.jp` で起動・到達。
- **🚦Daikiゲート**: 公開前にDaiki確認。

### Phase 9：パイロット実行（AGA おすすめ）
- **実装**: seed「AGA おすすめ」で全パイプライン実行。Phase 3の校正値で[B]を回す。
- **受け入れ**: 4成果物＋コンプラ・フロア充足結果。
- **🚦Daikiゲート（最終）**: Daikiが真=美ゲートでレビュー → 校正値・しきい値をconfig tableに凍結 → greenfield第1サイロ確定。

---

## 4. 横断要件（全フェーズ共通）

- **config駆動**: 全しきい値はconfig table。コードに数値を埋めない。校正出力で更新、versioned。
- **audit log**: status昇格・しきい値変更・コンプラ判定を全て記録（s-tools/カニバリ系の方式に合わせる）。
- **冪等性**: 同一seedの再実行で差分が追える（キャッシュ活用・SERP/embeddingは共有層から）。
- **テスト**: 各レイヤーにユニットテスト。校正ハーネスは根拠（分布・ROC）を可視出力。

---

## 5. Claude Codeの最初のアクション

```
1. silo-coverage-designer-requirements.md を読む
2. SSHでVPSに接続し、cannibalization-system の
   デプロイ/インフラ/共有データ層構成を inspect
3. インフラ構成マップ ＋ repo雛形案 ＋ kw.anonymous-seo.jp 紐付け方針
   ＋ 外部API疎通結果 をまとめる
4. ⛔ ここで停止し、Daikiの承認を待つ（Phase 0ゲート）
```

機能実装はPhase 0承認後に開始する。

---

## 6. Daikiが埋める空欄（Phase 0前 or Phase 0内で確定）

- repo名 → `anonymous-seo-a/kw`（確定・空repo）✅ ※public/private設定はDaiki判断
- Claude CodeのVPSアクセス手段（SSH鍵の共有方法）
- secretsの受け渡し方法（GSC/SerpAPI/Ahrefs/NLP/Claude）
