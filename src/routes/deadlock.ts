import { Hono } from "hono";
import { runTriggerSafe, runTriggerUnsafe } from "../lib/deadlock-trigger-core.js";

export const deadlockRoutes = new Hono();

/**
 * ❌ デッドロックを意図的に再現する
 *
 * 2つのトランザクションを並列実行:
 *   TxA: chat_rooms X lock → sleep → chat_messages INSERT（外部キーでS lock競合）
 *   TxB: chat_messages INSERT（暗黙S lock）→ sleep → chat_rooms UPDATE（X lock待ち）
 *
 * curl -X POST http://localhost:3000/deadlock/trigger \
 *   -H "Content-Type: application/json" \
 *   -d '{"roomId": 1}'
 */
deadlockRoutes.post("/trigger", async (c) => {
  const body = await c.req.json();
  const { roomId = 1 } = body;

  console.log("\n========== デッドロック再現開始 ==========");
  const results = await runTriggerUnsafe(roomId);
  console.log("========== デッドロック再現終了 ==========\n");

  return c.json({
    description: "デッドロック再現テスト（リトライなし）",
    results,
    note: "MySQLがデッドロックを検知し、どちらかのTxをロールバックします",
  });
});

/**
 * ✅ ロック順序修正済み＋リトライあり（比較用）
 *
 * 同じ並列実行でも、SELECT FOR UPDATE で親を先にロックすることで
 * デッドロックが発生しないことを確認する
 *
 * curl -X POST http://localhost:3000/deadlock/trigger-safe \
 *   -H "Content-Type: application/json" \
 *   -d '{"roomId": 1}'
 */
deadlockRoutes.post("/trigger-safe", async (c) => {
  const body = await c.req.json();
  const { roomId = 1 } = body;

  console.log("\n========== 安全なtx並列実行開始 ==========");
  const results = await runTriggerSafe(roomId);
  console.log("========== 安全なtx並列実行終了 ==========\n");

  return c.json({
    description: "ロック順序修正済み＋リトライあり（比較用）",
    results,
    note: "SELECT FOR UPDATE で親を先にロックすることで両Txが正常完了します",
  });
});
