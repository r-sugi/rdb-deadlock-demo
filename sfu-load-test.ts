/**
 * SELECT FOR UPDATE × 負荷試験専用スクリプト（ADR §4.6）
 *
 * シナリオA: 同一 roomId 高競合 — SFU キューイングによる P95/P99 増加を計測
 * シナリオB: SFU あり vs デッドロック版 — レイテンシ・エラー率比較
 * シナリオC: 別ルームへの波及 — コネクションプール汚染を確認
 *
 * 使い方: npx tsx sfu-load-test.ts
 */

import { performance } from "perf_hooks";

const CONFIG = {
  BASE_URL: "http://localhost:3000",
  ROOM_ID_HOT: 1,       // 高競合ルーム
  ROOM_ID_COLD: 2,      // 別ルーム（波及確認用）
  TIMEOUT_MS: 60_000,   // SFU 順番待ちは長くなるため余裕を持たせる
  SCENARIO_A_LEVELS: [2, 5, 10, 20, 50] as const,
  SCENARIO_B_CONCURRENCY: 10,
  SCENARIO_C_HOT_CONCURRENCY: 20,
  SCENARIO_C_COLD_COUNT: 5,
};

// ---- 型定義 ----

interface Result {
  index: number;
  label: string;
  status: number | "error" | "timeout";
  durationMs: number;
  deadlock: boolean;
  error?: string;
}

// ---- ユーティリティ ----

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function isDeadlockBody(body: unknown): boolean {
  const s = body ? JSON.stringify(body).toLowerCase() : "";
  return s.includes("deadlock") || s.includes("p2034") || s.includes("write conflict");
}

async function request(
  label: string,
  index: number,
  url: string,
  body: unknown
): Promise<Result> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);
  const start = performance.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const durationMs = Math.round(performance.now() - start);
    let resBody: unknown;
    try { resBody = await res.json(); } catch { /* ignore */ }

    return {
      index,
      label,
      status: res.status,
      durationMs,
      deadlock: isDeadlockBody(resBody),
    };
  } catch (e: unknown) {
    const durationMs = Math.round(performance.now() - start);
    const err = e instanceof Error ? e.message : String(e);
    const isTimeout = err.includes("abort") || err.includes("timeout");
    return {
      index,
      label,
      status: isTimeout ? "timeout" : "error",
      durationMs,
      deadlock: false,
      error: err,
    };
  } finally {
    clearTimeout(timer);
  }
}

function stats(results: Result[]) {
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const success = results.filter((r) => typeof r.status === "number" && r.status < 300).length;
  const timeouts = results.filter((r) => r.status === "timeout").length;
  const errors = results.filter((r) => r.status === "error").length;
  const deadlocks = results.filter((r) => r.deadlock).length;
  return {
    total: results.length,
    success,
    timeouts,
    errors,
    deadlocks,
    avg: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    max: durations[durations.length - 1] ?? 0,
  };
}

function hr(char = "=", n = 64) { return char.repeat(n); }

// ============================================================
// シナリオ A: 同一 roomId 高競合（SFU キューイング計測）
// ============================================================

async function scenarioA(): Promise<void> {
  console.log(`\n${hr()}`);
  console.log("【シナリオA】同一 roomId 高競合 — SFU キューイング計測");
  console.log(`  対象: POST /deadlock/trigger-safe  roomId=${CONFIG.ROOM_ID_HOT}`);
  console.log(hr());

  const header = "CONCURRENCY |  total | success | deadlock | timeout |  avg |  P50 |  P95 |  P99 |  max";
  const sep    = hr("-", header.length);
  console.log(`\n${header}`);
  console.log(sep);

  const tableRows: string[] = [];

  for (const concurrency of CONFIG.SCENARIO_A_LEVELS) {
    const tasks = Array.from({ length: concurrency }, (_, i) =>
      request(
        `trigger-safe c=${concurrency}`,
        i,
        `${CONFIG.BASE_URL}/deadlock/trigger-safe`,
        { roomId: CONFIG.ROOM_ID_HOT }
      )
    );

    const results = await Promise.all(tasks);
    const s = stats(results);

    const row = `${String(concurrency).padStart(11)} | ${String(s.total).padStart(6)} | ${String(s.success).padStart(7)} | ${String(s.deadlocks).padStart(8)} | ${String(s.timeouts).padStart(7)} | ${String(s.avg).padStart(4)} | ${String(s.p50).padStart(4)} | ${String(s.p95).padStart(4)} | ${String(s.p99).padStart(4)} | ${String(s.max).padStart(4)}`;
    console.log(row);
    tableRows.push(row);

    // 次のレベルの前にロック解放を待つ
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(sep);
  console.log("\n  ※ 単位: ms。deadlock = 応答 JSON に deadlock/P2034 を含む件数");
  console.log(  "  ※ timeout = TIMEOUT_MS 超過");

  // 観察ポイントの出力
  console.log("\n  [観察ポイント]");
  console.log("  - CONCURRENCY 増加に伴い P95/P99 が線形に伸びているか？（SFU キューイングの証拠）");
  console.log("  - deadlock = 0 を維持しているか？（SFU の効果）");
  console.log("  - 高 CONCURRENCY で timeout が発生しているか？（lock_wait_timeout 超過）");
}

// ============================================================
// シナリオ B: SFU あり vs デッドロック版 比較
// ============================================================

async function scenarioB(): Promise<void> {
  const concurrency = CONFIG.SCENARIO_B_CONCURRENCY;
  console.log(`\n${hr()}`);
  console.log(`【シナリオB】unsafe vs safe レイテンシ比較  CONCURRENCY=${concurrency}`);
  console.log(`  対象: POST /deadlock/trigger（unsafe）vs /deadlock/trigger-safe（SFU）`);
  console.log(hr());

  // unsafe
  const unsafeTasks = Array.from({ length: concurrency }, (_, i) =>
    request("trigger-unsafe", i, `${CONFIG.BASE_URL}/deadlock/trigger`, { roomId: CONFIG.ROOM_ID_HOT })
  );
  const unsafeResults = await Promise.all(unsafeTasks);
  const us = stats(unsafeResults);

  await new Promise((r) => setTimeout(r, 1000));

  // safe
  const safeTasks = Array.from({ length: concurrency }, (_, i) =>
    request("trigger-safe", i, `${CONFIG.BASE_URL}/deadlock/trigger-safe`, { roomId: CONFIG.ROOM_ID_HOT })
  );
  const safeResults = await Promise.all(safeTasks);
  const ss = stats(safeResults);

  console.log(`\n${"指標".padEnd(20)} | ${"unsafe (デッドロック版)".padEnd(22)} | ${"safe (SFU版)".padEnd(16)}`);
  console.log(hr("-", 70));
  const rows = [
    ["デッドロック検出数",  `${us.deadlocks} / ${us.total}`, `${ss.deadlocks} / ${ss.total}`],
    ["タイムアウト",       String(us.timeouts),                String(ss.timeouts)],
    ["avg (ms)",           String(us.avg),                     String(ss.avg)],
    ["P50 (ms)",           String(us.p50),                     String(ss.p50)],
    ["P95 (ms)",           String(us.p95),                     String(ss.p95)],
    ["P99 (ms)",           String(us.p99),                     String(ss.p99)],
    ["max (ms)",           String(us.max),                     String(ss.max)],
  ];
  for (const [label, uv, sv] of rows) {
    console.log(`${label.padEnd(20)} | ${uv.padEnd(22)} | ${sv}`);
  }

  console.log("\n  [観察ポイント]");
  console.log("  - unsafe: デッドロック検出 > 0、safe: デッドロック検出 = 0");
  console.log("  - safe の avg/P95 は unsafe より長くなる場合がある（順番待ちのため）");
  console.log("  - unsafe は早期ロールバックで avg が短く見えることがある（失敗したものは即終了）");
}

// ============================================================
// シナリオ C: 別ルームへの波及（コネクションプール汚染）
// ============================================================

async function scenarioC(): Promise<void> {
  const hotConcurrency = CONFIG.SCENARIO_C_HOT_CONCURRENCY;
  const coldCount = CONFIG.SCENARIO_C_COLD_COUNT;

  console.log(`\n${hr()}`);
  console.log("【シナリオC】別ルームへの波及 — コネクションプール汚染確認");
  console.log(`  hot: roomId=${CONFIG.ROOM_ID_HOT} に CONCURRENCY=${hotConcurrency} の SFU 高競合`);
  console.log(`  cold: roomId=${CONFIG.ROOM_ID_COLD} に ${coldCount} 件を同タイミングで送信`);
  console.log(hr());

  // ベースライン: roomId=2 単独
  console.log("\n  [1/3] ベースライン計測（roomId=2 単独 × 5件）");
  const baselineTasks = Array.from({ length: coldCount }, (_, i) =>
    request("baseline-cold", i, `${CONFIG.BASE_URL}/deadlock/trigger-safe`, { roomId: CONFIG.ROOM_ID_COLD })
  );
  const baselineResults = await Promise.all(baselineTasks);
  const bs = stats(baselineResults);
  console.log(`     avg=${bs.avg}ms  P50=${bs.p50}ms  P95=${bs.p95}ms  P99=${bs.p99}ms  max=${bs.max}ms`);

  await new Promise((r) => setTimeout(r, 1500));

  // 高負荷フェーズ: roomId=1 に hotConcurrency 件を送りながら roomId=2 も同時計測
  console.log(`\n  [2/3] 高競合フェーズ（roomId=1 × ${hotConcurrency} 件 + roomId=2 × ${coldCount} 件を同時発射）`);

  const hotTasks = Array.from({ length: hotConcurrency }, (_, i) =>
    request("hot", i, `${CONFIG.BASE_URL}/deadlock/trigger-safe`, { roomId: CONFIG.ROOM_ID_HOT })
  );

  // hot と cold を同時に発射（cold は hot 発射直後）
  const hotPromise = Promise.all(hotTasks);
  await new Promise((r) => setTimeout(r, 100)); // hot が少し先に始まるよう 100ms ずらす

  const coldTasks = Array.from({ length: coldCount }, (_, i) =>
    request("contaminated-cold", i, `${CONFIG.BASE_URL}/deadlock/trigger-safe`, { roomId: CONFIG.ROOM_ID_COLD })
  );
  const [, coldResults] = await Promise.all([hotPromise, Promise.all(coldTasks)]);
  const cs = stats(coldResults);
  console.log(`     avg=${cs.avg}ms  P50=${cs.p50}ms  P95=${cs.p95}ms  P99=${cs.p99}ms  max=${cs.max}ms`);

  await new Promise((r) => setTimeout(r, 1500));

  // 回復確認
  console.log("\n  [3/3] 回復確認（高負荷終了後の roomId=2 × 5件）");
  const recoveryTasks = Array.from({ length: coldCount }, (_, i) =>
    request("recovery-cold", i, `${CONFIG.BASE_URL}/deadlock/trigger-safe`, { roomId: CONFIG.ROOM_ID_COLD })
  );
  const recoveryResults = await Promise.all(recoveryTasks);
  const rs = stats(recoveryResults);
  console.log(`     avg=${rs.avg}ms  P50=${rs.p50}ms  P95=${rs.p95}ms  P99=${rs.p99}ms  max=${rs.max}ms`);

  // 比較テーブル
  console.log(`\n${"フェーズ".padEnd(30)} | avg  | P50  | P95  | P99  | max`);
  console.log(hr("-", 64));
  console.log(`${"ベースライン（hot 負荷なし）".padEnd(30)} | ${String(bs.avg).padStart(4)} | ${String(bs.p50).padStart(4)} | ${String(bs.p95).padStart(4)} | ${String(bs.p99).padStart(4)} | ${String(bs.max).padStart(4)}`);
  console.log(`${"hot 高競合中（同時発射）".padEnd(30)} | ${String(cs.avg).padStart(4)} | ${String(cs.p50).padStart(4)} | ${String(cs.p95).padStart(4)} | ${String(cs.p99).padStart(4)} | ${String(cs.max).padStart(4)}`);
  console.log(`${"回復後".padEnd(30)} | ${String(rs.avg).padStart(4)} | ${String(rs.p50).padStart(4)} | ${String(rs.p95).padStart(4)} | ${String(rs.p99).padStart(4)} | ${String(rs.max).padStart(4)}`);

  const contaminated = cs.avg > bs.avg * 1.5;
  console.log(`\n  → コネクションプール汚染: ${contaminated ? "⚠️  検出（avg が 1.5 倍以上増加）" : "✅ 未検出（別ルームへの波及は軽微）"}`);
  console.log("  [観察ポイント]");
  console.log("  - 「hot 高競合中」の cold avg が「ベースライン」より有意に増加すればプール汚染の証拠");
  console.log("  - 回復後に戻れば、汚染はコネクション占有起因（ロック自体は別行を触っていない）");
}

// ============================================================
// メイン
// ============================================================

async function main() {
  console.log(hr("=", 64));
  console.log("SELECT FOR UPDATE × 負荷試験（ADR §4.6）");
  console.log(`BASE_URL: ${CONFIG.BASE_URL}  ROOM_HOT: ${CONFIG.ROOM_ID_HOT}  ROOM_COLD: ${CONFIG.ROOM_ID_COLD}`);
  console.log(hr("=", 64));

  // 疎通確認
  try {
    const health = await fetch(`${CONFIG.BASE_URL}/`);
    if (!health.ok) throw new Error(`status ${health.status}`);
    console.log("✅ API 疎通確認 OK");
  } catch (e) {
    console.error(`❌ API に接続できません: ${e}`);
    process.exit(1);
  }

  await scenarioA();
  await scenarioB();
  await scenarioC();

  console.log(`\n${hr()}`);
  console.log("✅ 全シナリオ完了");
  console.log(hr());
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
