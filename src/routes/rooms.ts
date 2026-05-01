import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";

export const roomRoutes = new Hono();

// ルーム一覧
roomRoutes.get("/", async (c) => {
  const rooms = await prisma.chatRoom.findMany({
    include: { _count: { select: { messages: true } } },
    orderBy: { id: "asc" },
  });
  return c.json(rooms);
});

// ルーム作成
roomRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const { name, description } = body;

  if (!name) {
    return c.json({ error: "name is required" }, 400);
  }

  const room = await prisma.$transaction(async (tx) => {
    return tx.chatRoom.create({
      data: { name, description },
    });
  });

  return c.json(room, 201);
});

// ルーム属性更新（TxAに相当）
// 意図的にsleepを挟んでtxを長く保持し、デッドロックを発生させやすくしている
roomRoutes.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const { name, description, sleepMs } = body;

  const room = await prisma.$transaction(async (tx) => {
    // 先に親行をロックしてから待機する（sleep をロック取得前に置くと ADR の「長時間保持」と不一致）
    await tx.$queryRaw`SELECT id FROM chat_rooms WHERE id = ${id} FOR UPDATE`;
    console.log(`[TxA] ルームID:${id} SELECT FOR UPDATE でロック取得`);
    if (sleepMs) {
      console.log(`[TxA] ルームID:${id} ${sleepMs}ms 待機（ロック保持中）`);
      await new Promise((r) => setTimeout(r, sleepMs));
    }

    return tx.chatRoom.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
      },
    });
  });

  return c.json(room);
});
