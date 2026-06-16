/**
 * SEO rank-tracking caps tests (#294) — the resolver that fills hard defaults. Default OFF + `dryrun`
 * provider is the safety property: an un-configured workspace fetches nothing and reports nothing.
 */
import { describe, expect, it } from "vitest";
import { resolveSeoCaps, SEO_DEFAULTS } from "../../src/seo/caps.js";

describe("resolveSeoCaps", () => {
  it("defaults to OFF + dryrun + us, no keywords (un-configured workspace is inert)", () => {
    const caps = resolveSeoCaps(undefined);
    expect(caps).toEqual(SEO_DEFAULTS);
    expect(caps.enabled).toBe(false);
    expect(caps.provider).toBe("dryrun");
    expect(caps.targetKeywords).toEqual([]);
  });

  it("honours a valid provider and rejects an unknown one (falls back to dryrun)", () => {
    expect(resolveSeoCaps({ provider: "serpapi" }).provider).toBe("serpapi");
    expect(resolveSeoCaps({ provider: "totally-made-up" }).provider).toBe("dryrun");
  });

  it("normalises the country and trims/limits keywords", () => {
    const caps = resolveSeoCaps({
      enabled: true,
      defaultCountry: "GB",
      targetKeywords: ["  ai marketing agency ", "", "autonomous marketing agents"],
    });
    expect(caps.enabled).toBe(true);
    expect(caps.defaultCountry).toBe("gb");
    expect(caps.targetKeywords).toEqual(["ai marketing agency", "autonomous marketing agents"]);
  });
});
