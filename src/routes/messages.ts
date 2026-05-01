import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";

export const messageRoutes = new Hono();

/**
 * ❌ 危険: 子→親の順でロックが発生しやすい実装
 * - chatMessage.createMany() のINSERT時に外部キー検証で chat_rooms に暗黙S lockが走る
 * - ルーム更新TxAがX lockを持っている場合に競合しデッドロック発生
 *
 * ※ lastMessageAt は「lastViewedAt（ルームを開くたびに更新するカラム）」に
 *   読み替えても同じデッドロックパターンが成立する。
 *   chat_rooms 行への書き込みである点が本質であり、カラム名は問わない。
 */
messageRoutes.post("/bulk", async (c) => {
  const body = await c.req.json();
  const { roomId, messages, sleepMs } = body;

  if (!roomId || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "roomId and messages[] are required" }, 400);
  }

  console.log(`[TxB - 危険] roomId:${roomId} メッセージ${messages.length}件作成開始`);

  const result = await prisma.$transaction(async (tx) => {
    // デッドロック検証用: sleepMsが指定されたらtx内で待機
    if (sleepMs) {
      console.log(`[TxB - 危険] ${sleepMs}ms待機中...`);
      await new Promise((r) => setTimeout(r, sleepMs));
    }

    // ⚠️ ここでINSERT時にMySQLが自動でchat_roomsにS lockを取得する
    await tx.chatMessage.createMany({
      data: messages.map((m: { content: string }) => ({
        roomId,
        content: m.content,
      })),
    });

    // ⚠️ その後にルームを更新 → 子→親の順になりデッドロックリスク上昇
    const updatedRoom = await tx.chatRoom.update({
      where: { id: roomId },
      data: {
        lastMessageAt: new Date(),
      },
    });

    return updatedRoom;
  });

  console.log(`[TxB - 危険] 完了`);
  return c.json(result, 201);
});

/**
 * ✅ 安全: 親→子の順でロックを取得する実装
 * - SELECT FOR UPDATE で先にchat_roomsをX lockで取得
 * - その後にchat_messagesをINSERT → 順序が統一されデッドロック発生しない
 */
messageRoutes.post("/bulk-safe", async (c) => {
  const body = await c.req.json();
  const { roomId, messages, sleepMs } = body;

  if (!roomId || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "roomId and messages[] are required" }, 400);
  }

  console.log(`[TxB - 安全] roomId:${roomId} メッセージ${messages.length}件作成開始`);

  const result = await prisma.$transaction(async (tx) => {
    // ✅ 先にルームをX lockで取得（親→子の順を強制）
    await tx.$queryRaw`
      SELECT id FROM chat_rooms WHERE id = ${roomId} FOR UPDATE
    `;
    console.log(`[TxB - 安全] chat_rooms X lock取得済み`);

    if (sleepMs) {
      console.log(`[TxB - 安全] ${sleepMs}ms待機中...`);
      await new Promise((r) => setTimeout(r, sleepMs));
    }

    // ✅ X lock取得後にINSERT → 外部キー検証のS lockは既にX lockで上書き済み
    await tx.chatMessage.createMany({
      data: messages.map((m: { content: string }) => ({
        roomId,
        content: m.content,
      })),
    });

    // ✅ 親→子の順が守られている
    const updatedRoom = await tx.chatRoom.update({
      where: { id: roomId },
      data: {
        lastMessageAt: new Date(),
      },
    });

    return updatedRoom;
  });

  console.log(`[TxB - 安全] 完了`);
  return c.json(result, 201);
});
