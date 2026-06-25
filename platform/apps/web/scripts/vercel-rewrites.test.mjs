import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const vercelConfig = JSON.parse(await readFile(resolve(process.cwd(), "../../vercel.json"), "utf8"));

function rewriteFor(source) {
  return vercelConfig.rewrites.find((rewrite) => rewrite.source === source);
}

describe("Vercel API rewrites", () => {
  it("routes representative production API paths to api.ipop.ai before the SPA fallback", () => {
    const fallbackIndex = vercelConfig.rewrites.findIndex((rewrite) => rewrite.destination === "/index.html");

    for (const source of ["/healthz", "/ws", "/onboarding/:path*", "/inbound/:path*", "/me/:path*", "/workspaces/:path*"]) {
      const index = vercelConfig.rewrites.findIndex((rewrite) => rewrite.source === source);
      expect(index, source).toBeGreaterThanOrEqual(0);
      expect(index, source).toBeLessThan(fallbackIndex);
      expect(rewriteFor(source).destination, source).toMatch(/^https:\/\/api\.ipop\.ai\//);
    }
  });
});
