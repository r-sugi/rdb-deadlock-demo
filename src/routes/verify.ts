import { Hono } from "hono";
import {
  resultsIndicateDeadlock,
  runTriggerSafe,
  runTriggerUnsafe,
} from "../lib/deadlock-trigger-core.js";
import { prisma } from "../lib/prisma.js";

export const verifyRoutes = new Hono();

function isDeadlockError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /deadlock|Deadlock|P2034|write conflict/i.test(msg);
}

/**
 * ADR シナリオ②相当: 同一 roomId で
 * - TxA: SELECT FOR UPDATE で親行を掴んだまま sleep → 属性UPDATE（PATCH と同等）
 * - TxB: bulk（危険）または bulk-safe（SELECT FOR UPDATE 先行）
 * を並列に走らせ、SELECT FOR UPDATE による安全側の効果を JSON で比較する。
 *
 * POST /verify/patch-vs-bulk
 * body: { roomId?: number, sleepMs?: number, delayBulkMs?: number }
 */
verifyRoutes.post("/patch-vs-bulk", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const roomId = Number(body.roomId ?? 1);
  const sleepMs = Number(body.sleepMs ?? 400);
  const delayBulkMs = Number(body.delayBulkMs ?? 50);

  if (!Number.isFinite(roomId) || roomId < 1) {
    return c.json({ error: "roomId must be a positive integer" }, 400);
  }

  /** PATCH 相当: 先に FOR UPDATE で X lock → sleep → 更新 */
  function patchHoldTransaction() {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chat_rooms WHERE id = ${roomId} FOR UPDATE`;
      console.log(`[verify TxA] room ${roomId} FOR UPDATE 済み、${sleepMs}ms 保持`);
      if (sleepMs > 0) {
        await new Promise((r) => setTimeout(r, sleepMs));
      }
      return tx.chatRoom.update({
        where: { id: roomId },
        data: {
          description: `verify-patch ${new Date().toISOString()}`,
        },
      });
    });
  }

  /** messages/bulk と同じ順序（子 INSERT → 親 UPDATE） */
  function bulkDangerousTransaction() {
    return prisma.$transaction(async (tx) => {
      await tx.chatMessage.createMany({
        data: [{ roomId, content: `verify-danger ${Date.now()}` }],
      });
      return tx.chatRoom.update({
        where: { id: roomId },
        data: { lastMessageAt: new Date() },
      });
    });
  }

  /** messages/bulk-safe と同じ（FOR UPDATE → INSERT → UPDATE） */
  function bulkSafeTransaction() {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chat_rooms WHERE id = ${roomId} FOR UPDATE`;
      await tx.chatMessage.createMany({
        data: [{ roomId, content: `verify-safe ${Date.now()}` }],
      });
      return tx.chatRoom.update({
        where: { id: roomId },
        data: { lastMessageAt: new Date() },
      });
    });
  }

  async function runParallel(
    label: string,
    bulkFn: () => ReturnType<typeof bulkDangerousTransaction>,
  ) {
    const bulkDelayed = async () => {
      if (delayBulkMs > 0) {
        await new Promise((r) => setTimeout(r, delayBulkMs));
      }
      return bulkFn();
    };

    const settled = await Promise.allSettled([patchHoldTransaction(), bulkDelayed()]);

    const patchSettled = settled[0];
    const bulkSettled = settled[1];

    return {
      label,
      patch: {
        status: patchSettled.status,
        deadlock: patchSettled.status === "rejected" && isDeadlockError(patchSettled.reason),
        error:
          patchSettled.status === "rejected"
            ? patchSettled.reason instanceof Error
              ? patchSettled.reason.message
              : String(patchSettled.reason)
            : undefined,
      },
      bulk: {
        status: bulkSettled.status,
        deadlock: bulkSettled.status === "rejected" && isDeadlockError(bulkSettled.reason),
        error:
          bulkSettled.status === "rejected"
            ? bulkSettled.reason instanceof Error
              ? bulkSettled.reason.message
              : String(bulkSettled.reason)
            : undefined,
      },
    };
  }

  const dangerous = await runParallel("dangerous-bulk", bulkDangerousTransaction);
  const safe = await runParallel("bulk-safe-with-sfu", bulkSafeTransaction);

  const sfuEffective =
    dangerous.bulk.deadlock || dangerous.patch.deadlock
      ? !safe.bulk.deadlock && !safe.patch.deadlock
      : dangerous.bulk.status === "fulfilled" && safe.bulk.status === "fulfilled"
        ? null
        : !safe.bulk.deadlock && !safe.patch.deadlock;

  return c.json({
    meta: {
      roomId,
      sleepMs,
      delayBulkMs,
      note: "TxA は SELECT FOR UPDATE 後に sleep。TxB は delayBulkMs 後に開始。dangerous と safe を順に実行。",
    },
    dangerous,
    safe,
    interpretation: {
      selectForUpdateOnBulkSide:
        "bulk-safe 側はトランザクション先頭で SELECT FOR UPDATE により親行のロック順序を揃える実装。",
      sfuAvoidedDeadlockOnSafeRun:
        sfuEffective === null
          ? "今回の試行では両パターンともデッドロック未検出（タイミング依存）。複数回実行してください。"
          : sfuEffective
            ? "危険側でデッドロック検出があり、安全側では検出なし → SELECT FOR UPDATE 先行が有効な試行。"
            : "危険側でデッドロックが出なかった、または安全側でも失敗あり。sleepMs を延ばす・複数回試行してください。",
      patchVsBulkLimitation:
        "TxA がメッセージ INSERT しない場合、ブロックのみでデッドロックにならないことがある。確実な対比は POST /verify/deadlock-ordering を参照。",
    },
  });
});

/**
 * TxA: chat_rooms UPDATE → sleep → chat_messages INSERT（/deadlock/trigger の片側と同型）
 * TxB（危険）: chat_messages INSERT → chat_rooms UPDATE
 * TxB（安全）: SELECT FOR UPDATE → chat_messages INSERT → chat_rooms UPDATE
 *
 * `iterations` 回ずつ（デフォルト 20）危険パターンと安全パターンを **順番に** 試行し、
 * デッドロック検出回数を集計する（単発では再現しにくいため）。
 *
 * POST /verify/deadlock-ordering
 * body: { roomId?, txASleepMs?, txBStartDelayMs?, iterations? (1〜50) }
 */
verifyRoutes.post("/deadlock-ordering", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const roomId = Number(body.roomId ?? 1);
  const txASleepMs = Number(body.txASleepMs ?? 200);
  const txBStartDelayMs = Number(body.txBStartDelayMs ?? 50);
  const iterations = Math.min(50, Math.max(1, Math.floor(Number(body.iterations ?? 20))));

  if (!Number.isFinite(roomId) || roomId < 1) {
    return c.json({ error: "roomId must be a positive integer" }, 400);
  }

  function txA() {
    return prisma.$transaction(async (tx) => {
      await tx.chatRoom.update({
        where: { id: roomId },
        data: { description: `ordering-verify-A ${new Date().toISOString()}` },
      });
      console.log(`[verify ordering TxA] room ${roomId} 更新後 ${txASleepMs}ms 待機`);
      if (txASleepMs > 0) {
        await new Promise((r) => setTimeout(r, txASleepMs));
      }
      await tx.chatMessage.create({
        data: { roomId, content: `ordering-txa-${Date.now()}` },
      });
    });
  }

  function txBDangerous() {
    return prisma.$transaction(async (tx) => {
      if (txBStartDelayMs > 0) {
        await new Promise((r) => setTimeout(r, txBStartDelayMs));
      }
      await tx.chatMessage.createMany({
        data: [{ roomId, content: `ordering-txb-d-${Date.now()}` }],
      });
      await tx.chatRoom.update({
        where: { id: roomId },
        data: { lastMessageAt: new Date() },
      });
    });
  }

  function txBSafe() {
    return prisma.$transaction(async (tx) => {
      if (txBStartDelayMs > 0) {
        await new Promise((r) => setTimeout(r, txBStartDelayMs));
      }
      await tx.$queryRaw`SELECT id FROM chat_rooms WHERE id = ${roomId} FOR UPDATE`;
      console.log(`[verify ordering TxB-safe] SELECT FOR UPDATE 取得`);
      await tx.chatMessage.createMany({
        data: [{ roomId, content: `ordering-txb-s-${Date.now()}` }],
      });
      await tx.chatRoom.update({
        where: { id: roomId },
        data: { lastMessageAt: new Date() },
      });
    });
  }

  function summarizeIteration(settled: PromiseSettledResult<unknown>[]) {
    const [a, b] = settled;
    const anyDeadlock =
      (a.status === "rejected" && isDeadlockError(a.reason)) ||
      (b.status === "rejected" && isDeadlockError(b.reason));
    return { anyDeadlock };
  }

  let dangerousDeadlockRuns = 0;
  let safeDeadlockRuns = 0;
  let lastDangerousSettled: PromiseSettledResult<unknown>[] | null = null;
  let lastSafeSettled: PromiseSettledResult<unknown>[] | null = null;

  for (let i = 0; i < iterations; i++) {
    const dangerousSettled = await Promise.allSettled([txA(), txBDangerous()]);
    lastDangerousSettled = dangerousSettled;
    if (summarizeIteration(dangerousSettled).anyDeadlock) {
      dangerousDeadlockRuns += 1;
    }
  }

  for (let i = 0; i < iterations; i++) {
    const safeSettled = await Promise.allSettled([txA(), txBSafe()]);
    lastSafeSettled = safeSettled;
    if (summarizeIteration(safeSettled).anyDeadlock) {
      safeDeadlockRuns += 1;
    }
  }

  const dangerousRate = dangerousDeadlockRuns / iterations;
  const safeRate = safeDeadlockRuns / iterations;

  function detailed(settled: PromiseSettledResult<unknown>[] | null, label: string) {
    if (!settled) {
      return { label, txA: {}, txB: {}, anyDeadlock: false };
    }
    const [a, b] = settled;
    return {
      label,
      txA: {
        status: a.status,
        deadlock: a.status === "rejected" && isDeadlockError(a.reason),
      },
      txB: {
        status: b.status,
        deadlock: b.status === "rejected" && isDeadlockError(b.reason),
      },
      anyDeadlock:
        (a.status === "rejected" && isDeadlockError(a.reason)) ||
        (b.status === "rejected" && isDeadlockError(b.reason)),
    };
  }

  const sfuShowsBenefit = dangerousDeadlockRuns > 0 && safeDeadlockRuns === 0;

  return c.json({
    meta: {
      roomId,
      txASleepMs,
      txBStartDelayMs,
      iterations,
      txAPattern: "chat_rooms UPDATE → sleep → chat_messages INSERT",
      txBDangerousPattern: "chat_messages INSERT → chat_rooms UPDATE",
      txBSafePattern: "SELECT FOR UPDATE chat_rooms → chat_messages INSERT → chat_rooms UPDATE",
    },
    aggregate: {
      dangerousDeadlockRuns,
      safeDeadlockRuns,
      dangerousDeadlockRate: Number(dangerousRate.toFixed(3)),
      safeDeadlockRate: Number(safeRate.toFixed(3)),
    },
    lastIterationSample: {
      dangerous: detailed(lastDangerousSettled, "TxB dangerous"),
      safe: detailed(lastSafeSettled, "TxB safe"),
    },
    conclusion: {
      selectForUpdateEffectiveByAggregate: sfuShowsBenefit,
      explanation: sfuShowsBenefit
        ? `${iterations} 試行あたり: 危険 TxB でデッドロック ${dangerousDeadlockRuns} 回、SELECT FOR UPDATE 先行の TxB で 0 回。`
        : dangerousDeadlockRuns === 0 && safeDeadlockRuns === 0
          ? "集計でもデッドロック未検出。DB負荷・同時リクエストでは /deadlock/trigger や load-test を併用してください。"
          : `危険側 DL=${dangerousDeadlockRuns} / ${iterations}、安全側 DL=${safeDeadlockRuns} / ${iterations}。`,
    },
  });
});

/**
 * `/deadlock/trigger` と同一ロジックを **2本同時** に走らせる（HTTP で二重 POST したのと同等）。
 * 続けて `/deadlock/trigger-safe` 相当も 2 本同時で同一回数試行し、
 * SELECT FOR UPDATE＋リトライの有無によるデッドロック発生差を集計する。
 *
 * POST /verify/concurrent-trigger-pairs
 * body: { roomId?: number, iterations?: number (1〜100) }
 */
verifyRoutes.post("/concurrent-trigger-pairs", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const roomId = Number(body.roomId ?? 1);
  const iterations = Math.min(100, Math.max(1, Math.floor(Number(body.iterations ?? 30))));

  if (!Number.isFinite(roomId) || roomId < 1) {
    return c.json({ error: "roomId must be a positive integer" }, 400);
  }

  let unsafePairsWithDeadlock = 0;
  let safePairsWithDeadlock = 0;

  for (let i = 0; i < iterations; i++) {
    const [resA, resB] = await Promise.all([runTriggerUnsafe(roomId), runTriggerUnsafe(roomId)]);
    if (resultsIndicateDeadlock(resA) || resultsIndicateDeadlock(resB)) {
      unsafePairsWithDeadlock += 1;
    }
  }

  for (let i = 0; i < iterations; i++) {
    const [resA, resB] = await Promise.all([runTriggerSafe(roomId), runTriggerSafe(roomId)]);
    if (resultsIndicateDeadlock(resA) || resultsIndicateDeadlock(resB)) {
      safePairsWithDeadlock += 1;
    }
  }

  const verified = unsafePairsWithDeadlock > 0 && safePairsWithDeadlock === 0;

  return c.json({
    meta: {
      roomId,
      iterations,
      note: "各試行は「trigger 相当を2並列」を1回。unsafe ブロック完了後に safe ブロックを同回数実行。",
    },
    aggregate: {
      unsafePairsWithAnyDeadlock: unsafePairsWithDeadlock,
      safePairsWithAnyDeadlock: safePairsWithDeadlock,
      unsafeDeadlockRate: Number((unsafePairsWithDeadlock / iterations).toFixed(3)),
      safeDeadlockRate: Number((safePairsWithDeadlock / iterations).toFixed(3)),
    },
    conclusion: {
      selectForUpdateAndRetryEffectiveThisRun: verified,
      summary: verified
        ? `${iterations} 試行中: リトライなし・SFU なしの二本並列でデッドロックを ${unsafePairsWithDeadlock} 回観測、SELECT FOR UPDATE＋リトライの二本並列では 0 回。`
        : safePairsWithDeadlock > 0
          ? "安全側でもデッドロック文字列が結果に含まれた（稀）。ログと DB を確認してください。"
          : unsafePairsWithDeadlock === 0
            ? "非安全側でも今回は検出なし。iterations を増やすか、別プロセスから HTTP を二重に叩いてください。"
            : `非安全: ${unsafePairsWithDeadlock}/${iterations}, 安全: ${safePairsWithDeadlock}/${iterations}`,
    },
  });
});
