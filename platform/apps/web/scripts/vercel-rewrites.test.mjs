import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const vercelConfig = JSON.parse(await readFile(resolve(process.cwd(), "../../vercel.json"), "utf8"));

function rewriteFor(source) {
  return vercelConfig.rewrites.find((rewrite) => rewrite.source === source);
}

function rewriteSourcesTo(destination) {
  return vercelConfig.rewrites.filter((rewrite) => rewrite.destination === destination).map((rewrite) => rewrite.source);
}

describe("Vercel API rewrites", () => {
  it("routes representative production API paths to api.ipop.ai before the SPA fallback", () => {
    const firstSpaRewriteIndex = vercelConfig.rewrites.findIndex((rewrite) => rewrite.destination === "/index.html");

    for (const source of ["/healthz", "/ws", "/onboarding/:path*", "/inbound/:path*", "/me/:path*", "/workspaces/:path*"]) {
      const index = vercelConfig.rewrites.findIndex((rewrite) => rewrite.source === source);
      expect(index, source).toBeGreaterThanOrEqual(0);
      expect(index, source).toBeLessThan(firstSpaRewriteIndex);
      expect(rewriteFor(source).destination, source).toMatch(/^https:\/\/api\.ipop\.ai\//);
    }
  });

  it("routes arbitrary unknown public URLs to the app so React can render the branded 404", () => {
    expect(rewriteFor("/(.*)")).toBeUndefined();
    expect(vercelConfig.rewrites.at(-1)).toEqual({ source: "/:path*", destination: "/index.html" });
  });

  it("keeps dynamic public SPA prefixes before the final branded-404 fallback", () => {
    expect(rewriteSourcesTo("/index.html")).toEqual([
      "/status/:path*",
      "/dogfood/:path*",
      "/compare/:path*",
      "/stories/:path*",
      "/guides/:path*",
      "/changelog/:path*",
      "/brand/:path*",
      "/segments/:path*",
      "/:path*",
    ]);
  });
});
