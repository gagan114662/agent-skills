import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["test/unit/**/*.slow.test.ts"],
  },
});
