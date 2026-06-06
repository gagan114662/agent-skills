import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    // integration tests hit a real Postgres; keep them serial for clear failures
    fileParallelism: false,
    testTimeout: 20000,
  },
});
