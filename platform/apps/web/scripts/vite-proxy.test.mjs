import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Vite dev API proxy", () => {
  it("proxies public onboarding routes instead of letting the SPA swallow first-run reads", async () => {
    const viteConfig = await readFile(resolve(process.cwd(), "vite.config.ts"), "utf8");

    expect(viteConfig).toContain('"/onboarding": API_ORIGIN');
  });
});
