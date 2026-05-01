# Deadlock Demo

MySQLデッドロック検証用のHono + Node.js + Prismaプロジェクト。

## セットアップ

```bash
# 依存関係インストール
pnpm install

# DBを起動
docker compose up -d

# DBが起動するまで数秒待つ
# マイグレーション実行
pnpm db:migrate

# シードデータ投入
pnpm dlx tsx prisma/seed.ts

# 開発サーバー起動
pnpm dev
```

## ポート

| サービス | ホストポート | コンテナポート |
|----------|-------------|---------------|
| MySQL 8.4 | **13306** | 3306 |
| PostgreSQL 18 | **25432** | 5432 |
| API Server | **3000** | - |

## PostgreSQLへの切り替え

`.env` を編集：
```env
# MySQLをコメントアウト
# DATABASE_URL="mysql://demo:demo@localhost:13306/deadlock_demo"

# PostgreSQLを有効化
DATABASE_URL="postgresql://demo:demo@localhost:25432/deadlock_demo"
```

`prisma/schema.prisma` のproviderを変更：
```prisma
datasource db {
  provider = "postgresql"  # mysql → postgresql
  url      = env("DATABASE_URL")
}
```

再マイグレーション：
```bash
pnpm db:migrate
```

## API エンドポイント

### ルーム

```bash
# ルーム一覧
curl http://localhost:3000/rooms

# ルーム作成
curl -X POST http://localhost:3000/rooms \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Room", "description": "テスト"}'

# ルーム属性更新（SELECT FOR UPDATE 後に sleepMs でロック保持）
curl -X PATCH http://localhost:3000/rooms/1 \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated Room", "sleepMs": 500}'
```

### メッセージ

```bash
# ❌ 危険: 子→親の順でロック（デッドロック発生しやすい）
curl -X POST http://localhost:3000/messages/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "roomId": 1,
    "messages": [
      {"content": "こんにちは"},
      {"content": "元気？"}
    ]
  }'

# ✅ 安全: 親→子の順でロック（SELECT FOR UPDATE）
curl -X POST http://localhost:3000/messages/bulk-safe \
  -H "Content-Type: application/json" \
  -d '{
    "roomId": 1,
    "messages": [
      {"content": "こんにちは"},
      {"content": "元気？"}
    ]
  }'
```

### デッドロック検証

```bash
# ❌ デッドロックを意図的に再現（リトライなし）
curl -X POST http://localhost:3000/deadlock/trigger \
  -H "Content-Type: application/json" \
  -d '{"roomId": 1}'

# ✅ ロック順序修正済み＋リトライあり（比較用）
curl -X POST http://localhost:3000/deadlock/trigger-safe \
  -H "Content-Type: application/json" \
  -d '{"roomId": 1}'
```

### SELECT FOR UPDATE 効果の集計（検証 API）

`trigger` / `trigger-safe` と同一 Tx ロジックを **2 並列×複数回** 実行し、デッドロック検出の差を JSON で取得する。

```bash
curl -s -X POST http://localhost:3000/verify/concurrent-trigger-pairs \
  -H "Content-Type: application/json" \
  -d '{"roomId": 1, "iterations": 30}' | jq .
```

### 並列でデッドロックを誘発する例

ターミナルを2つ開いて同時実行：

```bash
# ターミナル1: ルーム更新（500ms sleep）
curl -X PATCH http://localhost:3000/rooms/1 \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated", "sleepMs": 500}'

# ターミナル2: メッセージ複数作成（同時実行）
curl -X POST http://localhost:3000/messages/bulk \
  -H "Content-Type: application/json" \
  -d '{"roomId": 1, "messages": [{"content": "test"}]}'
```

## デッドロック確認（MySQL）

```bash
docker exec -it deadlock_demo_mysql mysql -u demo -pdemo deadlock_demo

# デッドロックログを確認
SHOW ENGINE INNODB STATUS\G
```
