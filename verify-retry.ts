/**
 * ADR シナリオ④: withRetry のリトライログ出力を直接検証する。
 * DB に接続しない（retry.ts の純粋ロジックのみ）。
 */
import { withRetry } from "./src/lib/retry.js";

async function main() {
  console.log("=== withRetry 単体検証 ===");
  let attempts = 0;

  const result = await withRetry(async () => {
    attempts++;
    if (attempts < 2) {
      const err: Error & { code?: string } = new Error(
        "Transaction failed due to a write conflict or a deadlock"
      );
      err.code = "P2034";
      throw err;
    }
    return "success";
  }, 3, 50);

  console.log(`結果: ${result}  試行回数: ${attempts}`);
}

main().catch(console.error);
