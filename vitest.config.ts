import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "services/*/test/**/*.test.ts", "eval/test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // DB-backed suites each create their own database, so files can run in parallel.
    fileParallelism: true,
    maxWorkers: 4,
  },
});
