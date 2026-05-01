/**
 * デッドロック検知＋リトライユーティリティ
 * PrismaのデッドロックエラーコードはP2034
 */
export async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 50): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const isDeadlock =
        (e as { code?: string })?.code === "P2034" || // Prisma deadlock code
        (e as { message?: string })?.message?.includes("Deadlock") ||
        (e as { message?: string })?.message?.includes("deadlock");

      if (isDeadlock && i < retries - 1) {
        console.warn(
          `[Retry] デッドロック検知 (${i + 1}/${retries})、${delayMs * (i + 1)}ms後にリトライ`,
        );
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  // TypeScriptの型推論のためのフォールバック（実際には到達しない）
  throw new Error("Retry failed");
}
