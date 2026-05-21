# Silo Coverage Designer (kw.anonymous-seo.jp)

トップKW 1語から、SEO上位獲得に必要なエンティティ領域を最小被覆で出力するKW設計ツール。

仕様: [docs/requirements.md](docs/requirements.md)
ビルド計画: [docs/instructions.md](docs/instructions.md)

## Stack

- Node.js 20 / TypeScript (ESM, tsx 直起動)
- better-sqlite3 (WAL)
- Express + React/Vite (UI は Phase 7)
- biome / vitest
- Anthropic Claude / Voyage embeddings / SerpAPI / Google NLP / GSC

## Layout

```
src/
  lib/        # env, db, logger, voyage, claude, serpapi, google-nlp, gsc, config, audit, runs
  ingestion/  # [L1] sources (gsc, llm-fanout, serp, nlp) + candidate merger
  api/        # Express server + routes
  cli/        # tsx-runnable scripts
  ui/         # Vite root (placeholder)
db/
  schema.sql            # 最新スキーマの参考
  migrations/0001_*.sql # 適用順
  migrations/shared_*.sql # /opt/shared 用（kw / cannibalization 共有）
scripts/
  db-migrate.ts
  verify-env.ts
  verify-db.ts
  verify-apis.ts
```

## Setup

```bash
cp .env.example .env   # 値を埋める。コミットしない
npm install
npm run db:migrate
npm run verify:env
npm run verify:db
npm run verify:apis    # ライブAPI疎通（少額消費）
```

## Run [L1] on a seed

```bash
npm run l1:run -- --seed "AGA おすすめ" --vertical medical
```

無料ソースのみ（GSC / Claude fan-out / SerpAPI PAA・related・autocomplete / Google NLP）。
Ahrefs は **[L2] 以降のみ** 使用（仕様: ユニット浪費禁止）。

## Shared data layer

embedding / SERP は `/opt/shared/{voyage-cache,serp-cache}.db` の独立SQLiteを参照する。
cannibalization-system と同居しても二重保持しないための物理境界。

## Deploy

GitHub Actions → SSH `root@VPS_HOST` → `git pull (https・anonymous)` → `npm ci` → `pm2 restart kw-app`。
nginx vhost: `kw.anonymous-seo.jp` → `127.0.0.1:4050`（basic auth）。

## Phase progress

- [x] Phase 0: infra inspection + scaffold (this commit)
- [ ] Phase 1: [L1] free-source ingestion ← 動作中
- [ ] Phase 2: [L2] enrichment + Ahrefs unit budget
- [ ] Phase 3: [B] boundary + calibration harness (🚦 Daiki gate)
- [ ] Phase 4: [L3]/[NEC]/コンプラ・フロア/[COV] (🚦 Daiki gate)
- [ ] Phase 5: [DIFF]/[L4]/[L5]
- [ ] Phase 6: [L6] 真=美 + 4 outputs (🚦 Daiki gate)
- [ ] Phase 7: ダッシュボード (5タブ)
- [ ] Phase 8: deploy to kw.anonymous-seo.jp (🚦 Daiki gate)
- [ ] Phase 9: pilot run on "AGA おすすめ" (🚦 Daiki final gate)
