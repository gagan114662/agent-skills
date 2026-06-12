import { describe, it, expect } from "vitest";
import { BROWSER_DEFAULTS, resolveBrowserCaps } from "../../src/runtime/browser/caps.js";

describe("resolveBrowserCaps (#174)", () => {
  it("defaults to OFF with unlimited (0) caps and empty domain lists", () => {
    const caps = resolveBrowserCaps(undefined);
    expect(caps).toEqual(BROWSER_DEFAULTS);
    expect(caps.enabled).toBe(false);
    expect(caps.maxPages).toBe(0);
    expect(caps.allowlist).toEqual([]);
    expect(caps.denylist).toEqual([]);
  });

  it("overrides only the fields the config sets, keeping defaults for the rest", () => {
    const caps = resolveBrowserCaps({ enabled: true, maxPages: 20 });
    expect(caps.enabled).toBe(true);
    expect(caps.maxPages).toBe(20);
    expect(caps.maxWallClockSeconds).toBe(0);
    expect(caps.maxBandwidthBytes).toBe(0);
  });

  it("normalises the allow/denylist (trim, lower-case, dedupe, drop blanks)", () => {
    const caps = resolveBrowserCaps({
      enabled: true,
      allowlist: [" Example.com ", "example.com", ""],
      denylist: ["*.Evil.io", "  "],
    });
    expect(caps.allowlist).toEqual(["example.com"]);
    expect(caps.denylist).toEqual(["*.evil.io"]);
  });
});
