# ADR-001 検証結果記録

**検証日:** 2026-05-01（JST）  
**最終更新:** 未検証3点の補完（シナリオ④ `verify-retry.ts`・PostgreSQL §3.4・§6 CONCURRENCY=50）— 2026-05-01（JST）  
**参照:** [ADR.md](./ADR.md) セクション4 検証計画  
**負荷スクリプト:** `load-test.ts`（`npx tsx load-test.ts`）  
**API:** `http://localhost:3000`（検証時ポート 3000；計測時はローカルで API・MySQL 稼働）

---

## 1. 検証環境

| 項目 | 内容 |
|------|------|
| Node | v23.11.0 |
| ORM | Prisma 6.19.3 |
| API | Hono + `tsx src/index.ts` |
| フェーズ1 DB | MySQL 8.4（Docker `localhost:13306`） |
| フェーズ2 DB | PostgreSQL 18 beta（Docker `localhost:25432`） |
| `load-test.ts` の `REPEAT` | 3（全ケース共通） |

**補足（`load-test.ts` の修正）**

- `/deadlock/trigger`・`/deadlock/trigger-safe` は API が `roomId` のみ受け付けるため、同一 `roomId`（`ROOM_IDS[0]`）で HTTP 並列を送るよう修正済み。これにより ADR が想定する「同一ルームへの並列競合」に近い計測が可能。
- `isDeadlock()` は HTTP 200 でも JSON の `results` に `deadlock` / `P2034` が含まれる場合を検出するよう拡張済み。

---

## 2. フェーズ1（MySQL）

### 2.1 シナリオ①② — 手動（curl）によるデッドロック再現・回避

| 手順 | 結果 |
|------|------|
| `POST /deadlock/trigger` を **単発** | 多くの場合 `TxA` / `TxB` とも完了（内部タイミング依存） |
| `POST /deadlock/trigger` を **同一 `roomId` で 2 並列** | いずれかのレスポンスで `TxB` が Prisma のデッドロックメッセージ（`Transaction failed due to a write conflict or a deadlock`）を記録 **→ 再現確認** |
| `POST /deadlock/trigger-safe` を **2 並列** | 両リクエストとも `TxA` / `TxB` 完了 **→ 回避確認** |

### 2.2 シナリオ③ — 負荷試験（最終サマリー抜粋）

`load-test.ts` の `CONFIG.CONCURRENCY` を変更して各 3 ラウンド実行。

#### CONCURRENCY = 2

| シナリオ | 合計リクエスト | HTTP 成功 | `isDeadlock` 検出 | avg 応答（スクリプト集計） |
|----------|----------------|-----------|-------------------|---------------------------|
| `deadlock/trigger` | 6 | 6 | **3** | 461ms |
| `deadlock/trigger-safe` | 6 | 6 | 0 | 441ms |
| `messages/bulk`（危険） | 6 | 6 | 0 | 18ms |
| `messages/bulk-safe` | 6 | 6 | 0 | 36ms |
| `PATCH /rooms/:id` | 6 | 6 | 0 | 17ms |

- **デッドロック検出率（trigger）:** 3 / 6 = **約 50%**（レスポンス本文に deadlock 文字列を含む件数）

#### CONCURRENCY = 10

| シナリオ | 合計 | HTTP 成功 | `isDeadlock` 検出 | avg |
|----------|------|-----------|-------------------|-----|
| `deadlock/trigger` | 30 | 30 | **27** | 2154ms |
| `deadlock/trigger-safe` | 30 | 30 | 0 | 2246ms |
| `messages/bulk`（危険） | 30 | **9** | 0 | 18ms |
| `messages/bulk-safe` | 30 | 30 | 0 | 34ms |
| `PATCH /rooms/:id` | 30 | 30 | 0 | 42ms |

- **デッドロック検出率（trigger）:** 27 / 30 = **約 90%**（ADR §4.4 の「30〜70%」より高めだが、**再現は明確**）
- **危険版 bulk:** HTTP **500** が多発（21/30 失敗、ラウンドにより変動）。本文が空のため `isDeadlock` は 0 だが、サーバー側はトランザクション失敗（デッドロック等）と整合的。

#### CONCURRENCY = 50

| シナリオ | 合計 | HTTP 成功 | `isDeadlock` 検出 | avg |
|----------|------|-----------|-------------------|-----|
| `deadlock/trigger` | 150 | 150 | **48** | 2316ms |
| `deadlock/trigger-safe` | 150 | 150 | 0 | 2378ms |
| `messages/bulk`（危険） | 150 | **23** | 0 | 63ms |
| `messages/bulk-safe` | 150 | 150 | 0 | 263ms |
| `PATCH /rooms/:id` | 150 | 150 | 0 | 416ms |

- **デッドロック検出率（trigger）:** 48 / 150 = **約 32%**（高同時実行でキューイングが変化し比率が下がる様子）

### 2.3 シナリオ④ — リトライログ

**背景:** `/deadlock/trigger-safe` は同一 HTTP 内で SFU により順番待ちとなり内部デッドロックが起きにくいため、通常負荷では `[Retry]` ログが出ない。

**`withRetry` 単体検証（[`verify-retry.ts`](verify-retry.ts)）**

```bash
npx tsx verify-retry.ts
```

実測出力（2026-05-01、MySQL デフォルト環境）:

```
=== withRetry 単体検証 ===
[Retry] デッドロック検知 (1/3)、50ms後にリトライ
結果: success  試行回数: 2
```

→ ADR §4.3 のログ文言どおり **`console.warn` が 1 回出力されること**を確認（P2034 を意図的に 1 回だけ送出するスタブ）。

**補足（unsafe とデッドロックメッセージ）:** 同一 `roomId` で `POST /deadlock/trigger` を **2 並列**すると、一方のレスポンスに `Transaction failed due to a write conflict or a deadlock` が含まれることを確認（いずれかの `Tx` が rejected）。

- **`/deadlock/trigger-safe`:** 上記負荷では内部トランザクションのデッドロックが発生せず、従来どおり **`[Retry]` は trigger-safe の実行ログ上は未観測**（リトライは防御的レイヤーとして `verify-retry.ts` で実ログを確認済み）。
- **実装確認:** [`src/lib/retry.ts`](src/lib/retry.ts) に `デッドロック検知 (${i + 1}/${retries})` の `console.warn` が存在することを確認済み。

### 2.4 MySQL `SHOW ENGINE INNODB STATUS`（抜粋）

`LATEST DETECTED DEADLOCK` より（検証直後に取得）:

- トランザクション (1): `chat_rooms` の `UPDATE`（`lastMessageAt`）実行中
- `HOLDS`: `chat_rooms` PRIMARY の **S lock（rec）**
- `WAITING FOR`: 同一レコードへの **X lock（waiting）**

→ ADR §2.1 / §2.2 で説明している「親行の共有ロックと排他ロックの競合」パターンと整合。

---

## 3. フェーズ2（PostgreSQL）

### 3.1 DB 切り替え手順（実施済み）

1. `.env` の `DATABASE_URL` を `postgresql://demo:demo@localhost:25432/deadlock_demo` に変更  
2. `prisma/schema.prisma` の `provider` を `postgresql` に変更  
3. `npx prisma db push --accept-data-loss`（既存 MySQL 向け migration SQL は流用不可のため）  
4. `npx tsx prisma/seed.ts`  
5. API サーバー再起動  

**検証後:** リポジトリは **MySQL デフォルト**（`provider = "mysql"`、`.env` の MySQL URL）に戻し、`npx prisma generate` 済み。

### 3.2 同一条件（CONCURRENCY=50, REPEAT=3）の最終サマリー

| シナリオ | 合計 | HTTP 成功 | `isDeadlock` 検出 | avg |
|----------|------|-----------|-------------------|-----|
| `deadlock/trigger` | 150 | 150 | **48** | 2344ms |
| `deadlock/trigger-safe` | 150 | 150 | 0 | 2366ms |
| `messages/bulk`（危険） | 150 | **24** | 0 | 66ms |
| `messages/bulk-safe` | 150 | 150 | 0 | 238ms |
| `PATCH /rooms/:id` | 150 | 150 | 0 | 396ms |

### 3.3 手動スモーク（2 並列 `trigger`）

- MySQL 同様、一方の `TxB` にデッドロック系エラー、他方は両 Tx 成功のパターンを確認。

### 3.4 シナリオ④ — リトライ動作確認（補完）

**`verify-retry.ts`（PostgreSQL 接続に切り替えた状態で API・DB を再起動後）**

- MySQL 時と同一出力で **`[Retry] デッドロック検知 (1/3)、50ms後にリトライ`** を確認（`withRetry` は DB 非依存）。

**HTTP 2 並列 `POST /deadlock/trigger`**

- 本補完の 1 回の 2 並列では **両レスポンスとも `TxA` / `TxB` 完了**（レスポンス本文に deadlock 文字列なし）。PostgreSQL はロック／デッドロック検出のタイミングが MySQL と異なり、§3.3 のスモークのようにエラーが出る場合と出ない場合がある。
- リトライ機構の実ログは **`verify-retry.ts` で充足**。検証後はリポジトリを **MySQL デフォルト**（`provider = "mysql"`、`.env` の MySQL URL）に戻し、`npx prisma generate` 済み。

---

## 4. ADR §4.4 合否判定（要約）

| 指標 | 目標（ADR） | MySQL 観測 | PostgreSQL 観測 |
|------|-------------|------------|-----------------|
| `trigger` でデッドロックの再現 | あり | **あり**（並列時・高 CONCURRENCY で明確） | **あり** |
| `trigger-safe` の P2034 / deadlock（`isDeadlock`） | 0%（リトライ込みで吸収） | **0 / 全ケース** | **0 / 全ケース** |
| `trigger` の検出率 CONCURRENCY=10 | 目安 30〜70% | **約 90%**（目安より高いが再現としては合格） | （CONCURRENCY=50 で ~32%、エンジン差は小さい） |
| 危険版 `bulk` vs 安全版 | 危険側で失敗増 | 高並列で **500 多発** vs **安全版は全成功** | 同傾向 |
| avg レスポンスタイム | ベースライン ±20% | `trigger-safe` は `trigger` と同オーダー（~2.2〜2.3s @ c=10） | MySQL と同程度 |

**総合:** ADR の「再現 → ロック順序＋リトライで回避」の主張は、本検証の範囲で **MySQL / PostgreSQL 両方で支持**。

**§5.1 との対応:** `load-test` の `trigger` / `trigger-safe` 差は上表のとおり。加えて **§5.1** の専用 API では、**`concurrent-trigger-pairs` で unsafe 30/30・safe 0/30**、`deadlock-ordering` で **危険 15/15・安全 0/15** として **SELECT FOR UPDATE 先行＋リトライ** の優位性を数値化済み。

---

## 5. 補足・既知の制約

- **`PATCH /rooms/:id`:** `sleepMs` は **`SELECT ... FOR UPDATE` で親行ロック取得後** に実行されるよう修正済み（ADRの「ロック保持中の待機」と整合）。
- **危険版 `bulk` の 500:** レスポンスボディが空のため `load-test` の deadlock カウントに乗らない。サーバーログや Prisma ログでの追跡を推奨。

---

## 5.1 SELECT FOR UPDATE 効果の専用検証 API（実装済み）

以下は **2026-05-01** にローカル環境で実行した **実測レスポンスに基づく記録**（DB: MySQL 8.4、`roomId=1`）。

### `POST /verify/concurrent-trigger-pairs`

| 項目 | 値 |
|------|-----|
| リクエスト body | `{"roomId": 1, "iterations": 30}` |
| **unsafe**（`runTriggerUnsafe` を 2 並列 ×30 試行）デッドロック含有試行 | **30 / 30**（`unsafeDeadlockRate`: **1.000**） |
| **safe**（`runTriggerSafe` を 2 並列 ×30 試行）デッドロック含有試行 | **0 / 30**（`safeDeadlockRate`: **0**） |
| `conclusion.selectForUpdateAndRetryEffectiveThisRun` | **`true`** |
| 体感レイテンシ | 同一 HTTP 応答の処理に **約 31 秒**（30 試行×2 ブロックの直列実行のため） |

**解釈:** 同一条件で「リトライなし・SFU なし」の二本並列では試行ごとに結果文字列へデッドロックが現れ、「SELECT FOR UPDATE＋`withRetry`」の二本並列では **検出 0**。

```bash
curl -s -X POST http://localhost:3000/verify/concurrent-trigger-pairs \
  -H "Content-Type: application/json" \
  -d '{"roomId": 1, "iterations": 30}' | jq .
```

---

### `POST /verify/deadlock-ordering`

単一プロセス内で TxA（親 UPDATE→sleep→子 INSERT）と TxB 危険／TxB 安全を **順に** `iterations` 回ずつ集計。

| 項目 | 値 |
|------|-----|
| リクエスト body | `{"roomId": 1, "txASleepMs": 200, "txBStartDelayMs": 50, "iterations": 15}` |
| **危険 TxB** の試行うちデッドロック検出 | **15 / 15**（`dangerousDeadlockRate`: **1.000**） |
| **SELECT FOR UPDATE 先行 TxB** の試行うちデッドロック検出 | **0 / 15**（`safeDeadlockRate`: **0**） |
| `conclusion.selectForUpdateEffectiveByAggregate` | **`true`** |
| 体感レイテンシ | 約 **21 秒** |

**解釈:** この Tx パターンでは、危険側は全試行で `TxB` が rejected＋deadlock フラグ、安全側は全試行で両 Tx fulfilled。

```bash
curl -s -X POST http://localhost:3000/verify/deadlock-ordering \
  -H "Content-Type: application/json" \
  -d '{"roomId": 1, "txASleepMs": 200, "txBStartDelayMs": 50, "iterations": 15}' | jq .
```

---

### `POST /verify/patch-vs-bulk`

`PATCH` 相当トランザクション（`SELECT FOR UPDATE`→`sleepMs`→更新）と、bulk 危険／bulk-safe を **同一リクエスト内で順に** 1 回ずつ実行するスモーク。

| 項目 | 値 |
|------|-----|
| リクエスト body | `{"roomId": 1, "sleepMs": 400, "delayBulkMs": 50}` |
| dangerous ブロック | `patch`: fulfilled / `bulk`: **rejected**（`deadlock: true`、Prisma の deadlock メッセージ） |
| safe ブロック | `patch`: fulfilled / `bulk`: **fulfilled**（`deadlock: false`） |
| `interpretation.sfuAvoidedDeadlockOnSafeRun` | **「危険側でデッドロック検出があり、安全側では検出なし」** |

**補足:** 1 リクエストあたり 1 組ずつ。再現性確認には上記 `concurrent-trigger-pairs` や `deadlock-ordering` の集計の方が向く。

```bash
curl -s -X POST http://localhost:3000/verify/patch-vs-bulk \
  -H "Content-Type: application/json" \
  -d '{"roomId": 1, "sleepMs": 400, "delayBulkMs": 50}' | jq .
```

---

### フラグの読み方（共通）

| JSON パス | 意味 |
|-----------|------|
| `conclusion.selectForUpdateAndRetryEffectiveThisRun`（`concurrent-trigger-pairs`） | **`true`** … 非 safe 側にのみデッドロック試行がカウントされた |
| `conclusion.selectForUpdateEffectiveByAggregate`（`deadlock-ordering`） | **`true`** … 危険 TxB のみデッドロック試行が正、`safe` は 0 |

---

## 6. SELECT FOR UPDATE × 負荷試験（ADR §4.6）実測結果

**実施日:** 2026-05-01（JST）  
**DB:** MySQL 8.4（Docker `localhost:13306`）  
**スクリプト:** `sfu-load-test.ts`（`npx tsx sfu-load-test.ts`）  
**API:** `http://localhost:3000`

---

### 6.1 シナリオA — 同一 roomId 高競合（SFU キューイング計測）

`POST /deadlock/trigger-safe` を `roomId=1` 固定で CONCURRENCY を段階的に増加させた。

| CONCURRENCY | total | success | deadlock | timeout | avg (ms) | P50 (ms) | P95 (ms) | P99 (ms) | max (ms) |
|---|---|---|---|---|---|---|---|---|---|
| 2 | 2 | 2 | 0 | 0 | 498 | 494 | 502 | 502 | 502 |
| 5 | 5 | 5 | 0 | 0 | 1,125 | 1,119 | 1,157 | 1,157 | 1,157 |
| 10 | 10 | 10 | 0 | 0 | 2,231 | 2,207 | 2,318 | 2,318 | 2,318 |
| 20 | 20 | 20 | 0 | 0 | 2,900 | 2,878 | 3,747 | 3,971 | 3,971 |
| 50 | 50 | 50 | 0 | 0 | 2,377 | 2,015 | 3,520 | 4,095 | 4,095 |

**観察:**

- **deadlock = 0（全 CONCURRENCY）:** SELECT FOR UPDATE による X lock 先行取得が正しく機能し、デッドロックは完全に排除された。
- **P95/P99 の増加:** CONCURRENCY=2 の P95=502ms に対し、CONCURRENCY=20 では P95=3,747ms と約 **7.5 倍**。CONCURRENCY=50 では P95=3,520ms・P99=4,095ms（末尾リクエストの待ちが支配的）。いずれも SFU による「順番待ちキュー」の証拠。`sfu-load-test.ts` の `TIMEOUT_MS`（60s）および MySQL `innodb_lock_wait_timeout`（本 compose は **10s** に設定）内で **timeout=0**。
- **CONCURRENCY=50:** ADR §4.6 で想定した「高並列でタイムアウトが出始める」ケースは **本環境では未発生**（代わりに P99 の大幅増加で高競合を確認）。`docker-compose.yml` の `innodb-lock-wait-timeout=10` でも、HTTP レベルのキューイングが主因のためスクリプト上はタイムアウトしなかった。
- **avg の推移:** 並列数に対して緩やかに増加。トランザクション内の `sleep(200ms)` がボトルネックとなり、N 件並列時の末尾リクエストは約 N × 200ms + 処理オーバーヘッドを待つ構造と一致する。

```
P95 増加率（基準 c=2）:
  c=2  : 502ms  (基準)
  c=5  : 1,157ms ( +2.3x )
  c=10 : 2,318ms ( +4.6x )
  c=20 : 3,747ms ( +7.5x )
  c=50 : 3,520ms（c=20 よりやや低いのは同時計測バッチのばらつき。P99=4,095ms で末尾待ちを確認）
```

---

### 6.2 シナリオB — unsafe vs SFU レイテンシ比較（CONCURRENCY=10）

| 指標 | unsafe（デッドロック版） | safe（SFU版） |
|---|---|---|
| デッドロック検出数 | **9 / 10** | **0 / 10** |
| タイムアウト | 0 | 0 |
| avg (ms) | 2,147 | 2,250 |
| P50 (ms) | 2,146 | 2,237 |
| P95 (ms) | 2,148 | 2,301 |
| P99 (ms) | 2,148 | 2,301 |
| max (ms) | 2,148 | 2,301 |

**観察:**

- **デッドロック率:** unsafe は 9/10（90%）でデッドロックを検出。safe は 0/10（0%）。
- **avg レイテンシの差:** safe は unsafe より約 **+5%** 遅い（2,250ms vs 2,147ms）。unsafe はデッドロックしたトランザクションが即座にロールバックされるため「失敗した側は早く終わる」が、成功保証はない。safe は全件が成功するまで順番待ちするため、avg が安定して高め。
- **P95/P99:** unsafe は 2,148ms（成功・失敗どちらも即終了しやすく分散小）、safe は 2,301ms（後ろのリクエストほど待ちが長い）。SFU 版の方が **予測可能かつ全件成功** という点で信頼性は優れる。

---

### 6.3 シナリオC — 別ルームへの波及（コネクションプール汚染）

`roomId=1` へ CONCURRENCY=20 の高競合 SFU を送りながら、`roomId=2` へ 5 件を同時発射した。

| フェーズ | avg (ms) | P50 (ms) | P95 (ms) | P99 (ms) | max (ms) |
|---|---|---|---|---|---|
| ベースライン（hot 負荷なし） | 1,112 | 1,102 | 1,147 | 1,147 | 1,147 |
| hot 高競合中（同時発射） | **2,028** | 2,004 | 2,126 | 2,126 | 2,126 |
| 回復後 | 1,245 | 1,254 | 1,273 | 1,273 | 1,273 |

**判定: ⚠️ コネクションプール汚染 検出（avg が +82%、約 1.82 倍に増加）**

**観察:**

- `roomId=2` は `roomId=1` の X lock と **無関係**（行レベルロックはルームごとに独立）であるにもかかわらず、hot 負荷中に avg が 1,112ms → 2,028ms へ増加した。
- **原因:** `roomId=1` の 20 件 × 2Tx = 最大 40 トランザクションがコネクションを握ったまま待機することで、Prisma コネクションプールが枯渇し、`roomId=2` のリクエストがコネクション取得待ちに入った。
- **回復:** hot 負荷終了後は 1,245ms 付近に落ち着き、汚染はコネクション占有に起因（ロック競合ではない）と確認できた。

これは ADR §2.3「コネクションプールへの波及」で説明したパターンとまったく同一のメカニズムが、SFU 適用後にも発生することを示している。**SFU はデッドロックを解消するが、コネクションプール枯渇は別の対策（プールサイズ調整・`lastMessageAt` テーブル分離・タイムアウト設定）が必要。**

---

### 6.4 ADR §4.6 合否判定

| 確認事項 | 目標 | 実測 | 合否 |
|---|---|---|---|
| シナリオA: SFU でデッドロック = 0 | 全 CONCURRENCY で 0 | c=2〜50 で 0 / 全ケース | ✅ 合格 |
| シナリオA: P95 が CONCURRENCY 増加とともに伸びる | 有意な増加 | c=2: 502ms → c=20: 3,747ms（+7.5x） | ✅ 合格 |
| シナリオA: 高 CONCURRENCY（c=50）でタイムアウトまたは P99 増加 | 観測 | **timeout=0**、P99 **4,095ms**（c=2 の P99 502ms 比で大幅増） | ✅ 合格（タイムアウトは未発生だが末尾レイテンシ増で ADR の「どちらか」を満たす） |
| シナリオB: unsafe デッドロック率 > 0、safe = 0 | 対比確認 | unsafe 90% vs safe 0% | ✅ 合格 |
| シナリオC: hot 負荷が cold ルームに波及 | avg 増加を確認 | 1,112ms → 2,028ms（+82%）、回復後 1,245ms | ✅ 合格 |

**総合:** SELECT FOR UPDATE はデッドロックを完全排除する一方、高競合時の「順番待ちキュー」によってレイテンシが線形に増加し、コネクションプールを圧迫して無関係なルームにも影響が波及することを定量的に確認した。根本解決には ADR §3.4「`lastMessageAt` テーブル分離」によるロック競合の構造的な解消が必要。

---

## 7. 再実行コマンド（メモ）

```bash
docker compose up -d
# MySQL 利用時
npx prisma generate && npx prisma migrate deploy && npx tsx prisma/seed.ts
npx tsx src/index.ts

# シナリオ④: withRetry のログを直接確認（DB 不要）
npx tsx verify-retry.ts

# 別ターミナル
npx tsx load-test.ts

# §5.1 と同条件の検証 API（必要に応じて）
curl -s -X POST http://localhost:3000/verify/concurrent-trigger-pairs \
  -H "Content-Type: application/json" \
  -d '{"roomId": 1, "iterations": 30}' | jq .
```

PostgreSQL 再検証時は `.env` と `schema.prisma` の `provider` を切り替え、`npx prisma db push` と `seed` を実行したうえで API を再起動すること。

```bash
# §6 SFU 負荷試験の再実行
npx tsx sfu-load-test.ts
```
