import { prisma } from "./prisma.js";
import { withRetry } from "./retry.js";

/**
 * POST /deadlock/trigger と同一の TxA + TxB（リトライなし）
 */
export async function runTriggerUnsafe(roomId: number): Promise<string[]> {
  const results: string[] = [];

  const txA = prisma
    .$transaction(async (tx) => {
      console.log("[TxA] chat_rooms X lock取得");
      await tx.chatRoom.update({
        where: { id: roomId },
        data: { description: `TxA更新 ${new Date().toISOString()}` },
      });

      console.log("[TxA] 200ms待機中（TxBにS lockを取らせる）");
      await new Promise((r) => setTimeout(r, 200));

      console.log("[TxA] chat_messages INSERT（外部キー検証でS lock要求）");
      await tx.chatMessage.create({
        data: { roomId, content: "TxAからのメッセージ" },
      });

      results.push("TxA: 完了");
      console.log("[TxA] 完了");
    })
    .catch((e: Error) => {
      results.push(`TxA: エラー - ${e.message}`);
      console.error("[TxA] エラー:", e.message);
    });

  const txB = prisma
    .$transaction(async (tx) => {
      await new Promise((r) => setTimeout(r, 50));

      console.log("[TxB] chat_messages INSERT（暗黙S lock on chat_rooms）");
      await tx.chatMessage.createMany({
        data: [
          { roomId, content: "TxBからのメッセージ1" },
          { roomId, content: "TxBからのメッセージ2" },
        ],
      });

      console.log("[TxB] chat_rooms X lock要求（← ここでデッドロック発生）");
      await tx.chatRoom.update({
        where: { id: roomId },
        data: {
          lastMessageAt: new Date(),
        },
      });

      results.push("TxB: 完了");
      console.log("[TxB] 完了");
    })
    .catch((e: Error) => {
      results.push(`TxB: エラー - ${e.message}`);
      console.error("[TxB] エラー:", e.message);
    });

  await Promise.allSettled([txA, txB]);
  return results;
}

/**
 * POST /deadlock/trigger-safe と同一（withRetry + SELECT FOR UPDATE）
 */
export async function runTriggerSafe(roomId: number): Promise<string[]> {
  const results: string[] = [];

  const txA = withRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chat_rooms WHERE id = ${roomId} FOR UPDATE`;
      console.log("[TxA - 安全] X lock取得");

      await tx.chatRoom.update({
        where: { id: roomId },
        data: { description: `TxA安全更新 ${new Date().toISOString()}` },
      });

      await new Promise((r) => setTimeout(r, 200));

      await tx.chatMessage.create({
        data: { roomId, content: "TxA(安全)からのメッセージ" },
      });

      results.push("TxA: 完了");
      console.log("[TxA - 安全] 完了");
    })
  ).catch((e: Error) => {
    results.push(`TxA: エラー - ${e.message}`);
    console.error("[TxA - 安全] エラー:", e.message);
  });

  const txB = withRetry(() =>
    prisma.$transaction(async (tx) => {
      await new Promise((r) => setTimeout(r, 50));

      console.log("[TxB - 安全] X lock待ち...");
      await tx.$queryRaw`SELECT id FROM chat_rooms WHERE id = ${roomId} FOR UPDATE`;
      console.log("[TxB - 安全] X lock取得");

      await tx.chatMessage.createMany({
        data: [
          { roomId, content: "TxB(安全)からのメッセージ1" },
          { roomId, content: "TxB(安全)からのメッセージ2" },
        ],
      });

      await tx.chatRoom.update({
        where: { id: roomId },
        data: { lastMessageAt: new Date() },
      });

      results.push("TxB: 完了");
      console.log("[TxB - 安全] 完了");
    })
  ).catch((e: Error) => {
    results.push(`TxB: エラー - ${e.message}`);
    console.error("[TxB - 安全] エラー:", e.message);
  });

  await Promise.allSettled([txA, txB]);
  return results;
}

export function resultsIndicateDeadlock(results: string[]): boolean {
  const text = results.join("\n").toLowerCase();
  return (
    text.includes("deadlock") ||
    text.includes("p2034") ||
    text.includes("write conflict")
  );
}
