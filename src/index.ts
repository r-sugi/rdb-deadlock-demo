import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { roomRoutes } from "./routes/rooms.js";
import { messageRoutes } from "./routes/messages.js";
import { deadlockRoutes } from "./routes/deadlock.js";
import { verifyRoutes } from "./routes/verify.js";

const app = new Hono();

app.use("*", logger());

app.get("/", (c) => c.json({ message: "Deadlock Demo API", version: "1.0.0" }));

app.route("/rooms", roomRoutes);
app.route("/messages", messageRoutes);
app.route("/deadlock", deadlockRoutes);
app.route("/verify", verifyRoutes);

const port = Number(process.env.PORT) || 3000;
console.log(`Server running on http://localhost:${port}`);
console.log("");
console.log("=== Endpoints ===");
console.log("GET    /                          - ヘルスチェック");
console.log("POST   /rooms                     - ルーム作成");
console.log("PATCH  /rooms/:id                 - ルーム属性更新");
console.log("POST   /messages/bulk             - メッセージ複数作成（子→親順：デッドロック発生しやすい）");
console.log("POST   /messages/bulk-safe         - メッセージ複数作成（親→子順：安全）");
console.log("POST   /deadlock/trigger          - デッドロックを意図的に再現");
console.log("POST   /deadlock/trigger-safe     - ロック順序修正済みの比較");
console.log("POST   /verify/patch-vs-bulk       - PATCH相当ロック vs bulk（危険/安全）比較");
console.log("POST   /verify/deadlock-ordering      - Tx並列でロック順序を比較（単プロセス内）");
console.log("POST   /verify/concurrent-trigger-pairs - trigger×2並列 vs trigger-safe×2並列を集計");

serve({ fetch: app.fetch, port });
