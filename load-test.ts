/**
 * 同時アクセス検証スクリプト
 * 使い方: npx ts-node load-test.ts
 */

import { performance } from "perf_hooks";

// ============================================================
// ★ CONFIG: ここを変えるだけで挙動が変わる
// ============================================================
const CONFIG = {
  BASE_URL: "http://localhost:3000",
  CONCURRENCY: 2,          // 同時リクエスト数（検証時は 2 / 10 / 50 に変更）
  REPEAT: 3,               // 各シナリオの繰り返し回数
  ROOM_IDS: [1, 2, 3],     // デッドロック用のルームID（2件以上必要）
  TIMEOUT_MS: 10_000,      // リクエストタイムアウト
} as const;
// ============================================================

// ---------- 型定義 ----------
interface Result {
  scenario: string;
  index: number;
  status: number | "error";
  durationMs: number;
  error?: string;
  body?: unknown;
}

interface Summary {
  scenario: string;
  total: number;
  success: number;
  failed: number;
  deadlockErrors: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
}

// ---------- ユーティリティ ----------
async function request(
  scenario: string,
  index: number,
  url: string,
  options: RequestInit
): Promise<Result> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);
  const start = performance.now();

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const durationMs = Math.round(performance.now() - start);
    let body: unknown;
    try { body = await res.json(); } catch { /* ignore */ }

    return { scenario, index, status: res.status, durationMs, body };
  } catch (e: unknown) {
    const durationMs = Math.round(performance.now() - start);
    const error = e instanceof Error ? e.message : String(e);
    return { scenario, index, status: "error", durationMs, error };
  } finally {
    clearTimeout(timer);
  }
}

/** CONCURRENCY 件ずつ並列実行 */
async function runConcurrent(
  tasks: (() => Promise<Result>)[]
): Promise<Result[]> {
  const results: Result[] = [];
  for (let i = 0; i < tasks.length; i += CONFIG.CONCURRENCY) {
    const batch = tasks.slice(i, i + CONFIG.CONCURRENCY);
    const batchResults = await Promise.all(batch.map((t) => t()));
    results.push(...batchResults);
  }
  return results;
}

function isDeadlock(r: Result): boolean {
  const body = r.body as Record<string, unknown> | undefined;
  const msg = (body?.message ?? body?.error ?? r.error ?? "").toString().toLowerCase();
  // /deadlock/trigger は HTTP 200 で results[] に Deadlock/P2034 が含まれる
  const bodyStr = body ? JSON.stringify(body).toLowerCase() : "";
  return (
    msg.includes("deadlock") ||
    msg.includes("p2034") ||
    bodyStr.includes("deadlock") ||
    bodyStr.includes("p2034") ||
    r.status === 409
  );
}

// ---------- サマリー ----------
function summarize(results: Result[]): Summary {
  const durations = results.map((r) => r.durationMs);
  const success = results.filter((r) => r.status >= 200 && r.status < 300).length;
  const deadlockErrors = results.filter(isDeadlock).length;

  return {
    scenario: results[0]?.scenario ?? "unknown",
    total: results.length,
    success,
    failed: results.length - success,
    deadlockErrors,
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
    avgMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
  };
}

function printResults(results: Result[], label: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📋 ${label}`);
  console.log("=".repeat(60));

  for (const r of results) {
    const icon =
      isDeadlock(r) ? "🔴 DEADLOCK" :
      r.status === "error" ? "❌ ERROR  " :
      r.status >= 200 && r.status < 300 ? "✅ OK     " :
      `⚠️  ${r.status}    `;
    console.log(`  [${String(r.index).padStart(2)}] ${icon} | ${r.durationMs}ms | ${JSON.stringify(r.body ?? r.error ?? "").slice(0, 80)}`);
  }

  const s = summarize(results);
  console.log("-".repeat(60));
  console.log(`  合計: ${s.total}  成功: ${s.success}  失敗: ${s.failed}  デッドロック: ${s.deadlockErrors}`);
  console.log(`  応答時間: min=${s.minMs}ms  avg=${s.avgMs}ms  max=${s.maxMs}ms`);
}

// ============================================================
// シナリオ定義
// ============================================================

/** 1. POST /deadlock/trigger — デッドロック再現（同一 roomId でHTTP並列→DB競合） */
async function scenarioDeadlockTrigger(): Promise<Result[]> {
  const roomId = CONFIG.ROOM_IDS[0];
  const tasks = Array.from({ length: CONFIG.CONCURRENCY }, (_, i) =>
    () => request(
      "deadlock/trigger",
      i,
      `${CONFIG.BASE_URL}/deadlock/trigger`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId }),
      }
    )
  );
  return runConcurrent(tasks);
}

/** 2. POST /deadlock/trigger-safe — デッドロック回避版との比較 */
async function scenarioDeadlockSafe(): Promise<Result[]> {
  const roomId = CONFIG.ROOM_IDS[0];
  const tasks = Array.from({ length: CONFIG.CONCURRENCY }, (_, i) =>
    () => request(
      "deadlock/trigger-safe",
      i,
      `${CONFIG.BASE_URL}/deadlock/trigger-safe`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId }),
      }
    )
  );
  return runConcurrent(tasks);
}

/** 3. POST /messages/bulk — 危険な一括INSERT */
async function scenarioMessagesBulkDangerous(): Promise<Result[]> {
  const tasks = Array.from({ length: CONFIG.CONCURRENCY }, (_, i) =>
    () => request(
      "messages/bulk (危険)",
      i,
      `${CONFIG.BASE_URL}/messages/bulk`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId: CONFIG.ROOM_IDS[i % CONFIG.ROOM_IDS.length],
          messages: [
            { content: `Worker ${i} - message A` },
            { content: `Worker ${i} - message B` },
          ],
        }),
      }
    )
  );
  return runConcurrent(tasks);
}

/** 4. POST /messages/bulk-safe — 安全な一括INSERT */
async function scenarioMessagesBulkSafe(): Promise<Result[]> {
  const tasks = Array.from({ length: CONFIG.CONCURRENCY }, (_, i) =>
    () => request(
      "messages/bulk-safe",
      i,
      `${CONFIG.BASE_URL}/messages/bulk-safe`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId: CONFIG.ROOM_IDS[i % CONFIG.ROOM_IDS.length],
          messages: [
            { content: `Worker ${i} - message A` },
            { content: `Worker ${i} - message B` },
          ],
        }),
      }
    )
  );
  return runConcurrent(tasks);
}

/** 5. PATCH /rooms/:id — 同一ルームへの同時更新 */
async function scenarioRoomsConcurrentUpdate(): Promise<Result[]> {
  const roomId = CONFIG.ROOM_IDS[0]; // 意図的に同一ルームへ集中
  const tasks = Array.from({ length: CONFIG.CONCURRENCY }, (_, i) =>
    () => request(
      "PATCH /rooms/:id",
      i,
      `${CONFIG.BASE_URL}/rooms/${roomId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `Updated by worker ${i} at ${Date.now()}` }),
      }
    )
  );
  return runConcurrent(tasks);
}

// ============================================================
// メイン実行
// ============================================================
async function main() {
  console.log("🚀 同時アクセス検証スクリプト");
  console.log(`   BASE_URL   : ${CONFIG.BASE_URL}`);
  console.log(`   CONCURRENCY: ${CONFIG.CONCURRENCY}`);
  console.log(`   REPEAT     : ${CONFIG.REPEAT}`);
  console.log(`   ROOM_IDS   : ${CONFIG.ROOM_IDS.join(", ")}`);

  const allSummaries: Summary[] = [];

  for (let round = 1; round <= CONFIG.REPEAT; round++) {
    console.log(`\n${"#".repeat(60)}`);
    console.log(`# Round ${round} / ${CONFIG.REPEAT}`);
    console.log("#".repeat(60));

    // シナリオ一覧と実行関数
    const scenarios: [string, () => Promise<Result[]>][] = [
      ["① デッドロック再現 (trigger)",        scenarioDeadlockTrigger],
      ["② デッドロック回避 (trigger-safe)",    scenarioDeadlockSafe],
      ["③ Bulk INSERT 危険版",                 scenarioMessagesBulkDangerous],
      ["④ Bulk INSERT 安全版",                 scenarioMessagesBulkSafe],
      ["⑤ 同一ルーム同時UPDATE",              scenarioRoomsConcurrentUpdate],
    ];

    for (const [label, fn] of scenarios) {
      const results = await fn();
      printResults(results, label);
      allSummaries.push(summarize(results));
      // シナリオ間に少し待機（DBのロック解放を待つ）
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // 最終サマリーテーブル
  console.log(`\n${"=".repeat(60)}`);
  console.log("📊 最終サマリー（全ラウンド合算）");
  console.log("=".repeat(60));

  // シナリオ名でグループ集計
  const grouped = new Map<string, Summary[]>();
  for (const s of allSummaries) {
    if (!grouped.has(s.scenario)) grouped.set(s.scenario, []);
    grouped.get(s.scenario)!.push(s);
  }

  for (const [scenario, list] of grouped) {
    const total       = list.reduce((a, b) => a + b.total, 0);
    const success     = list.reduce((a, b) => a + b.success, 0);
    const failed      = list.reduce((a, b) => a + b.failed, 0);
    const deadlocks   = list.reduce((a, b) => a + b.deadlockErrors, 0);
    const avgMs       = Math.round(list.reduce((a, b) => a + b.avgMs, 0) / list.length);
    console.log(`  ${scenario.padEnd(25)} | 合計:${total} 成功:${success} 失敗:${failed} DL:${deadlocks} avg:${avgMs}ms`);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
