# Architecture Decision Record
## ADR-001: チャットサービス MySQLデッドロック対策

**作成日:** 2025年5月
**ステータス:** Accepted

---

## 1. コンテキスト

チャットサービスのバックエンドAPIにおいて、複数のエンドポイントが非同期で同一テーブルを更新する際にデッドロックが断続的に発生していた。

### 1.1 テーブル構成

現行スキーマ（本デモの `prisma/schema.prisma` に対応）の ER 図を以下に示す。

```mermaid
erDiagram
    chat_rooms {
        int id PK
        string name
        string description
        datetime lastMessageAt
        datetime createdAt
        datetime updatedAt
    }
    chat_messages {
        int id PK
        int roomId FK
        string content
        datetime createdAt
        datetime updatedAt
    }
    chat_rooms ||--o{ chat_messages : "1対多"
```

- `lastMessageAt` は `chat_rooms` 上に保持（メッセージ投稿 API から都度 UPDATE されうる）
- `chat_messages.roomId` は `chat_rooms.id` への外部キー

### 1.2 発生していた操作パターン

- **エンドポイントA:** `chat_rooms` の属性を UPDATE
- **エンドポイントB:** `chat_messages` を複数件 INSERT し、その後 `chat_rooms.lastMessageAt` を UPDATE
- 上記2つが非同期・並列で実行されることでデッドロックが発生

---

## 2. 原因分析

### 2.1 ロック取得順序の不統一（直接原因）

```mermaid
sequenceDiagram
    participant TxA as TxA（エンドポイントA）
    participant DB as MySQL
    participant TxB as TxB（エンドポイントB）

    TxA->>DB: chat_rooms X lock 取得
    TxB->>DB: chat_messages INSERT
    Note over DB,TxB: 外部キー検証で chat_rooms に暗黙 S lock 要求
    DB-->>TxB: ⏳ TxA の X lock と競合、待機
    TxA->>DB: chat_messages INSERT 試みる
    DB-->>TxA: ⏳ TxB の INSERT 待機中
    Note over TxA,TxB: 🔴 循環待ち → デッドロック発生
    DB-->>TxA: ❌ Deadlock detected (P2034)
    DB-->>TxB: ❌ ロールバック
```

各エンドポイントのトランザクション内でのロック取得順序がバラバラだったことが直接の原因。

```
TxA（エンドポイントA）: chat_rooms を X lock → chat_messages を INSERT
TxB（エンドポイントB）: chat_messages を INSERT → chat_rooms を X lock
```

### 2.2 外部キーによる暗黙 S lock

MySQL InnoDB は外部キー制約の整合性検証のため、`chat_messages` に INSERT する際に親行（`chat_rooms`）へ共有ロック（S lock）を**自動取得**する。Prisma のコードには一切書いていないため気づきにくい。

```sql
-- Prisma のコードに書いていないのに MySQL が内部で自動実行する
SELECT id FROM chat_rooms WHERE id = ? LOCK IN SHARE MODE
```

### 2.3 コネクションプールへの波及

```mermaid
flowchart TD
    A["TxA が chat_rooms を X lock\n（処理に時間がかかる）"]
    B["TxB が chat_rooms の S lock を待機\n（コネクションを占有したまま）"]
    C["待機中コネクションが増加"]
    D["コネクションプール枯渇"]
    E["別ルームへのリクエストも\nコネクション待ちで遅延"]

    A --> B --> C --> D --> E
```

ロックは行単位だが、コネクションはプール全体で共有されるリソース。待機中のトランザクションがコネクションを占有し続けることで、全く別のルームへのリクエストも含めてAPI全体のレスポンスが遅延する。

| 原因 | 影響範囲 |
|------|---------|
| ロック取得順序の不統一 | 同一ルームへのリクエスト間でデッドロック発生 |
| 外部キーによる暗黙 S lock | INSERT だけでもルーム UPDATE と競合 |
| コネクションプールの枯渇 | 無関係なルームへのリクエストにも遅延波及 |

---

## 3. 決定事項（Decision）

### 3.1 ロック取得順序を全txで統一する（最重要）

```mermaid
flowchart LR
    subgraph NG["❌ 対策前（順序バラバラ）"]
        direction TB
        A1["TxA: chat_rooms X lock"] --> A2["TxA: chat_messages INSERT"]
        B1["TxB: chat_messages INSERT"] --> B2["TxB: chat_rooms X lock"]
    end

    subgraph OK["✅ 対策後（親→子に統一）"]
        direction TB
        C1["TxA: chat_rooms X lock"] --> C2["TxA: chat_messages INSERT"]
        D1["TxB: chat_rooms X lock"] --> D2["TxB: chat_messages INSERT"]
    end

    style NG fill:#FFF5F5,stroke:#FC8181
    style OK fill:#F0FFF4,stroke:#68D391
```

全エンドポイントのトランザクション内で、必ず「親（`chat_rooms`）→ 子（`chat_messages`）」の順にロックを取得するルールを徹底する。

```typescript
// ✅ 正しい順序
await prisma.$transaction(async (tx) => {
  await tx.chatRoom.update(...)        // 親を先にロック
  await tx.chatMessage.createMany(...) // 子を後にロック
});
```

### 3.2 SELECT FOR UPDATE で明示的に先行ロックを取得する

子テーブルのみを操作するエンドポイントでも、事前に `SELECT FOR UPDATE` で親行を X lock することでロック取得順序を強制する。これにより外部キー検証の暗黙 S lock を X lock で上書きできる。

```typescript
await prisma.$transaction(async (tx) => {
  // 先に親を X lock（外部キー検証の暗黙 S lock を上書き）
  await tx.$queryRaw`
    SELECT id FROM chat_rooms WHERE id = ${roomId} FOR UPDATE
  `;
  await tx.chatMessage.createMany({ data: messages });
  await tx.chatRoom.update({
    where: { id: roomId },
    data: { lastMessageAt: new Date() }
  });
});
```

### 3.3 デッドロック検知＋リトライを必ず実装する

順序統一だけでは完全にゼロにはならないため、Prisma の P2034 エラーを検知してリトライするユーティリティを全 tx に適用する。

```typescript
async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 50): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e: any) {
      const isDeadlock = e?.code === 'P2034' || e?.message?.includes('deadlock');
      if (isDeadlock && i < retries - 1) {
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Retry exhausted');
}
```

### 3.4 頻繁に更新されるカラムを別テーブルへ切り出す（中長期）

改善前のテーブル構成は **§1.1 の ER 図**（`chat_rooms` に `lastMessageAt` が含まれる形）を参照。

改善後は `lastMessageAt` など更新頻度の高い属性を `chat_room_stats` に分離し、親テーブル `chat_rooms` の行はメッセージ投稿のたびに UPDATE されないようにする。

```mermaid
erDiagram
    chat_rooms {
        int id PK
        string name
        string description
        datetime createdAt
        datetime updatedAt
    }
    chat_room_stats {
        int roomId PK
        datetime lastMessageAt
        datetime updatedAt
    }
    chat_messages {
        int id PK
        int roomId FK
        string content
        datetime createdAt
        datetime updatedAt
    }
    chat_rooms ||--|| chat_room_stats : "1対1"
    chat_rooms ||--o{ chat_messages : "1対多"
```

- `chat_room_stats.roomId` は `chat_rooms.id` を参照する主キー兼外部キー（1 ルーム 1 行）
- 更新頻度の高い `lastMessageAt` は `chat_room_stats` 側のみが変更対象となり、`chat_rooms` 本体行はメッセージ投稿のたびに UPDATE されない想定

`lastMessageAt` などメッセージ作成時に毎回更新されるカラムを `chat_room_stats` として分離する。S lock 自体は外部キー制約がある限り消えないが、`chat_rooms` の行が更新されなければ競合が発生しなくなる。

### 3.5 DB移行方針：MySQL → PostgreSQL

上記対策はまず MySQL 8.4 で実施・検証する。その後、同一の対策コードのまま PostgreSQL 18 へ移行し、同等の効果が得られることを確認する。

PostgreSQL における外部キーの挙動の差異として、以下の点に注意する。

- PostgreSQL も外部キー制約がある限り INSERT 時に親行の参照ロックを取得するため、SELECT FOR UPDATE による先行ロックの対策は同様に有効である
- デッドロック検知時のエラーコードは PostgreSQL でも Prisma P2034 として同様に扱える
- 接続切り替えは `.env` の `DATABASE_URL` と `schema.prisma` の `provider` を `postgresql` に変更し、`prisma migrate dev` を再実行するだけで完了する

```bash
# .env の切り替え
# DATABASE_URL="mysql://demo:demo@localhost:13306/deadlock_demo"
DATABASE_URL="postgresql://demo:demo@localhost:25432/deadlock_demo"
```

```prisma
datasource db {
  provider = "postgresql"  // mysql → postgresql
  url      = env("DATABASE_URL")
}
```

### 対策の優先順位まとめ

| 優先度 | 対策 | 効果 |
|--------|------|------|
| 🔴 今すぐ | ロック取得順序の統一 | デッドロック頻度が激減 |
| 🔴 今すぐ | リトライ実装 | 残ったデッドロックをカバー |
| 🟡 次のステップ | SELECT FOR UPDATE | 順序をコードレベルで強制 |
| 🟡 次のステップ | PostgreSQL で同一検証を実施 | DBエンジン非依存であることを確認 |
| 🟢 中長期 | テーブル切り出し | 競合を構造レベルで解消 |

---

## 4. 検証計画

検証は **フェーズ1（MySQL）** で実施した後、**フェーズ2（PostgreSQL）** でも同一シナリオを再実施し、DBエンジンをまたいで対策の有効性を確認する。

```mermaid
flowchart TD
    Start(["検証開始"])
    P1["フェーズ1\nMySQL 8.4 で検証"]
    S1["シナリオ① デッドロック再現"]
    S2["シナリオ② ロック順序修正確認"]
    S3["シナリオ③ 負荷試験（定量評価）"]
    S4["シナリオ④ リトライ動作確認"]
    Judge1{{"合否判定"}}
    Switch["PostgreSQL へ切り替え\n.env & schema.prisma 変更\nprisma migrate dev"]
    P2["フェーズ2\nPostgreSQL 18 で検証"]
    S1b["シナリオ①〜④ 再実施"]
    Judge2{{"合否判定\n（MySQL 比較）"}}
    End(["✅ 検証完了"])

    Start --> P1
    P1 --> S1 --> S2 --> S3 --> S4 --> Judge1
    Judge1 -- "合格" --> Switch
    Judge1 -- "不合格" --> P1
    Switch --> P2 --> S1b --> Judge2
    Judge2 -- "合格" --> End
    Judge2 -- "不合格" --> P2

    style P1 fill:#EBF8FF,stroke:#4299E1
    style P2 fill:#F0FFF4,stroke:#48BB78
    style Judge1 fill:#FEFCBF,stroke:#D69E2E
    style Judge2 fill:#FEFCBF,stroke:#D69E2E
    style End fill:#C6F6D5,stroke:#38A169
```

### 4.1 検証環境

| 項目 | 内容 |
|------|------|
| フレームワーク | Hono + Node.js |
| ORM | Prisma |
| DB（フェーズ1） | MySQL 8.4 / ホストポート: 13306 |
| DB（フェーズ2） | PostgreSQL 18 / ホストポート: 25432 |
| 負荷スクリプト | `load-test.ts`（プロジェクトルートに配置） |

### 4.2 APIエンドポイント一覧

| エンドポイント | 役割 | デッドロックリスク |
|---------------|------|-----------------|
| `POST   /rooms` | ルーム作成 | 低 |
| `PATCH  /rooms/:id` | ルーム属性更新（先頭で `SELECT ... FOR UPDATE`、`sleepMs` はロック取得後に保持） | 高 |
| `POST   /messages/bulk` | メッセージ複数作成（子→親順：危険版） | 高 |
| `POST   /messages/bulk-safe` | メッセージ複数作成（親→子順：安全版） | 低 |
| `POST   /deadlock/trigger` | デッドロックを意図的に再現 | 確実に発生 |
| `POST   /deadlock/trigger-safe` | ロック順序修正済み（比較用） | 発生しない |
| `POST   /verify/concurrent-trigger-pairs` | `trigger` / `trigger-safe` と同一ロジックを **2 並列ずつ**繰り返し、デッドロック検出回数を JSON で集計（SELECT FOR UPDATE＋リトライの効果確認用） | （集計のみ） |
| `POST   /verify/patch-vs-bulk` | `PATCH` 相当（親ロック→sleep）と `bulk` 危険版／安全版の比較 | 参照 |
| `POST   /verify/deadlock-ordering` | 単一プロセス内の Tx 並列でロック順序のみ比較（デッドロックは出にくい場合あり） | 参照 |

### 4.3 フェーズ1：MySQL での検証シナリオと手順

#### シナリオ① デッドロックの再現確認

**目的:** 対策前の状態でデッドロックが実際に発生することを確認する。

1. `docker compose up -d` で DB を起動する
2. `pnpm dev` で API サーバーを起動する
3. ターミナルを2つ開き、以下を同時実行する

```bash
# ターミナル1: ルーム更新（500ms sleep でtxを長く保持）
curl -X PATCH http://localhost:3000/rooms/1 \
  -H 'Content-Type: application/json' \
  -d '{"name": "Updated", "sleepMs": 500}'

# ターミナル2: メッセージ複数作成（危険版）
curl -X POST http://localhost:3000/messages/bulk \
  -H 'Content-Type: application/json' \
  -d '{"roomId": 1, "messages": [{"content": "test"}]}'
```

**期待結果:** どちらか一方が Prisma P2034 / Deadlock エラーを返すこと。

```bash
# MySQLログでデッドロック確認
docker exec -it deadlock_demo_mysql \
  mysql -u demo -pdemo -e "SHOW ENGINE INNODB STATUS\G"
```

#### シナリオ② ロック順序修正の効果確認

**目的:** `SELECT FOR UPDATE` による先行ロックでデッドロックが解消されることを確認する。

1. シナリオ①と同じタイミングで、ターミナル2を `bulk-safe` に変更して実行する

```bash
curl -X POST http://localhost:3000/messages/bulk-safe \
  -H 'Content-Type: application/json' \
  -d '{"roomId": 1, "messages": [{"content": "test"}]}'
```

**期待結果:** 両リクエストが正常完了すること（片方が待機するが、デッドロックにはならない）。

##### （任意）シナリオ②の補足: `SELECT FOR UPDATE` 効果の一括集計

手動の二重 curl に代わり、次で同一ロジックをサーバ内で繰り返し集計できる。

```bash
curl -s -X POST http://localhost:3000/verify/concurrent-trigger-pairs \
  -H "Content-Type: application/json" \
  -d '{"roomId": 1, "iterations": 30}'
```

- **非安全:** `runTriggerUnsafe` を **2 並列** × `iterations` 回（`POST /deadlock/trigger` と同等の Tx 構成）。
- **安全:** `runTriggerSafe`（先頭 `SELECT FOR UPDATE`＋`withRetry`）を **2 並列** × 同じ回数。
- レスポンスの `aggregate` で、デッドロック文字列を含む試行数を比較する。

#### シナリオ③ 負荷試験による定量評価

**目的:** 同時アクセス数を変えて、デッドロック発生率・レスポンスタイムを計測する。

1. `load-test.ts` の CONFIG を調整する

```typescript
const CONFIG = {
  CONCURRENCY: 10,      // 2 → 10 → 50 と段階的に増やす
  REPEAT: 5,
  ROOM_IDS: [1, 2, 3],
};
```

2. `npx ts-node load-test.ts` を実行する
3. 出力の「最終サマリー」を記録する

| シナリオ | 目的 |
|---------|------|
| `POST /deadlock/trigger` | デッドロック発生率の確認 |
| `POST /deadlock/trigger-safe` | 成功率・応答時間を比較 |
| `POST /messages/bulk`（危険） | 並列 INSERT でのロック競合確認 |
| `POST /messages/bulk-safe`（安全） | 危険版との比較 |
| `PATCH /rooms/:id` 同時更新 | 同一行への同時 UPDATE 競合確認 |

#### シナリオ④ リトライの動作確認

**目的:** デッドロック発生時に `withRetry` が正しくリトライし、最終的に成功することを確認する。

1. `/deadlock/trigger` はリトライなしのため P2034 エラーが返ることを確認する
2. `/deadlock/trigger-safe` はリトライあり（`withRetry`）のため両 Tx が成功することを確認する
3. サーバーログで `デッドロック検知 (1/3)、Xms後にリトライ` が出力されることを確認する

### 4.4 合否判定基準

| 指標 | 対策前（期待値） | 対策後（目標値） |
|------|---------------|---------------|
| デッドロック発生率（CONCURRENCY=10） | 30〜70% | 0%（またはリトライで吸収） |
| avg レスポンスタイム | ベースライン | ベースライン ±20% 以内 |
| P2034 エラー率 | 発生あり | 0%（リトライ込み） |

### 4.5 フェーズ2：PostgreSQL での検証手順

MySQL での全シナリオが合否基準を満たした後、以下の手順で PostgreSQL に切り替えて同一シナリオを再実施する。

1. `.env` の `DATABASE_URL` を PostgreSQL 用に切り替える
2. `prisma/schema.prisma` の `provider` を `postgresql` に変更する
3. `pnpm db:migrate` を実行してマイグレーションを再適用する
4. `pnpm dlx tsx prisma/seed.ts` でシードデータを再投入する
5. シナリオ①〜④を MySQL 時と同じ CONFIG で再実施し、結果を比較する

| 確認項目 | MySQL | PostgreSQL（目標） |
|---------|-------|-----------------|
| デッドロック再現（trigger） | エラー発生を確認済み | MySQL と同様に発生すること |
| 対策後（trigger-safe） | 両Tx成功を確認済み | MySQL と同様に両Tx成功すること |
| P2034 エラー検知 | 動作確認済み | Prisma 経由で同一コードで検知できること |
| avg レスポンスタイム | ベースライン記録 | MySQL 比で大幅な劣化がないこと |

### 4.6 SELECT FOR UPDATE × 負荷試験（コネクションプール枯渇・レイテンシ増加の検証）

**目的:** `SELECT FOR UPDATE` を全トランザクションで先行取得する安全版（`trigger-safe`）が高競合下でどのような挙動を示すかを定量化する。

| 検証したい仮説 | 対応シナリオ |
|------|------|
| SFU は「デッドロック」を「順番待ち（キュー）」に変換するため、競合が強いと P95/P99 が線形に伸びる | シナリオA |
| SFU で待機するトランザクションがコネクションを占有し続けるため、高並列時にコネクションプールが枯渇する | シナリオA（高 CONCURRENCY） |
| コネクションプール枯渇は、高競合ルームと無関係な別ルームへのリクエストにも遅延を波及させる | シナリオC |
| SFU なし（デッドロック版）と SFU あり（安全版）は、高並列時のレイテンシ特性が異なる | シナリオB |

**スクリプト:** `sfu-load-test.ts`（`npx tsx sfu-load-test.ts`）

#### シナリオA: 同一 roomId 高競合（SFU キューイング計測）

**対象エンドポイント:** `POST /deadlock/trigger-safe`（roomId=1 固定）

内部実装の確認：
- 各 HTTP リクエスト内で TxA（SFU → UPDATE → sleep 200ms → INSERT）と TxB（50ms 遅延 → SFU → INSERT → UPDATE）が並列実行される
- N 件の HTTP リクエストが同時到達すると、最大 2N 個のトランザクションが同一行の X lock を取り合う
- X lock は 1 つしか保持できないため、残り 2N-1 個はコネクションを握ったまま待機する

| CONCURRENCY | 予測される振る舞い |
|---|---|
| 5 | 待ちは最大 ~2.0s。プール圧迫はほぼなし |
| 10 | 待ちは最大 ~4.5s。P95 が大幅に伸び始める |
| 20 | 待ちは最大 ~9s。MySQL `innodb_lock_wait_timeout`（デフォルト 50s）内だがプール圧迫が顕著 |
| 50 | 待ちは最大 ~22s。lock_wait_timeout エラーが発生し始める可能性あり |

計測項目：avg・P50・P95・P99 レイテンシ、タイムアウトエラー数

#### シナリオB: SFU あり vs デッドロック版 レイテンシ比較

**対象エンドポイント:** `POST /deadlock/trigger`（unsafe）vs `POST /deadlock/trigger-safe`（safe）

CONCURRENCY = 10 で同一 roomId に並列実行し、以下を比較する。

| 指標 | trigger (unsafe) | trigger-safe (SFU) |
|------|------|------|
| デッドロック検出数 | 高（30〜90%） | 0 |
| avg レイテンシ | 早期ロールバックで短くなる場合あり | 順番待ちで長くなる |
| P99 レイテンシ | 不安定（ロールバック→リトライ次第） | 安定して伸びる（予測可能） |

#### シナリオC: 別ルームへの波及確認（コネクションプール汚染）

**手順:**

1. roomId=1 へ CONCURRENCY=20 の `trigger-safe` を送り続ける（バックグラウンド）
2. 同タイミングで roomId=2 へ少数（5件）の `trigger-safe` を送る
3. ベースライン（roomId=1 高負荷なし状態）の roomId=2 レイテンシと比較する

**期待:** roomId=1 の X lock 待ちがコネクションを占有することで、ロック自体は無関係な roomId=2 のリクエストも、コネクション取得待ちに起因して遅延が増加する。

#### 合否判定基準（§4.6）

| 指標 | 確認事項 |
|------|------|
| シナリオA CONCURRENCY=10 の P95 | CONCURRENCY=2 の P95 と比べて明らかに増加すること（SFU 順番待ちの証拠） |
| シナリオA CONCURRENCY=50 | タイムアウトエラーまたは大幅な P99 増加が観測されること |
| シナリオB | unsafe のデッドロック率 > 0、safe のデッドロック率 = 0 |
| シナリオC | roomId=2 の avg が、負荷なし時と比べて増加すること |

---

## 5. 却下した選択肢

| 選択肢 | 却下理由 |
|--------|---------|
| 外部キー制約を削除する | データ整合性をアプリ側で担保する必要があり、バグリスクが高い |
| コネクションプールサイズのみ増加 | 根本解決にならず、デッドロック自体は解消しない |
| シリアライズ可能なトランザクション分離レベル | パフォーマンス影響が大きく、過剰対応 |

---

## 6. 今後の課題

- `chat_room_stats` テーブルへの `lastMessageAt` 切り出し（競合をスキーマレベルで解消）
- CONCURRENCY を 50 以上に増やした際のコネクションプール枯渇の検証（→ §4.6 SFU 負荷試験で対応）
- 本番環境での `SHOW ENGINE INNODB STATUS` モニタリング導入
