import { defineConfig } from "vitest/config";

/** Database tests: real PostgreSQL 17 with all migrations applied (see tests/db/global-setup.ts). */
export default defineConfig({
  test: {
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
