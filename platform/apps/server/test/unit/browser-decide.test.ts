import { describe, it, expect } from "vitest";
import { resolveBrowserCaps, type BrowserCaps } from "../../src/runtime/browser/caps.js";
import { decideBrowserStep, type BrowserUsage } from "../../src/runtime/browser/decide.js";

const ENABLED: BrowserCaps = resolveBrowserCaps({ enabled: true });
const ZERO_USAGE: BrowserUsage = { pages: 0, bytes: 0, elapsedMs: 0 };

describe("decideBrowserStep (#174 — the pure step gate)", () => {
  it("refuses everything when the runtime is disabled (defence-in-depth)", () => {
    const caps = resolveBrowserCaps(undefined); // enabled: false
    const d = decideBrowserStep({ tool: "read_page", caps, usage: ZERO_USAGE });
    expect(d.decision).toBe("disabled");
  });

  it("allows read-only browsing for free", () => {
    for (const tool of ["navigate", "read_page", "screenshot", "scroll", "wait"] as const) {
      const d = decideBrowserStep({ tool, target: "https://example.com", caps: ENABLED, usage: ZERO_USAGE });
      expect(d.decision).toBe("allow");
    }
  });

  it("requires approval for a side-effectful action with no prior approval", () => {
    const click = decideBrowserStep({ tool: "click", target: "https://example.com", caps: ENABLED, usage: ZERO_USAGE });
    expect(click.decision).toBe("needs_approval");
    const type = decideBrowserStep({ tool: "type", target: "https://example.com", caps: ENABLED, usage: ZERO_USAGE });
    expect(type.decision).toBe("needs_approval");
  });

  it("allows a side-effectful action once a human has approved it", () => {
    const d = decideBrowserStep({
      tool: "click",
      target: "https://example.com",
      caps: ENABLED,
      usage: ZERO_USAGE,
      approved: true,
    });
    expect(d.decision).toBe("allow");
  });

  it("NEVER enters credentials — even with an approval (forbidden, non-overridable)", () => {
    const d = decideBrowserStep({
      tool: "type",
      target: "https://example.com/login",
      caps: ENABLED,
      usage: ZERO_USAGE,
      approved: true,
      credentialEntry: true,
    });
    expect(d.decision).toBe("forbidden");
    expect(d.reason).toMatch(/credentials/);
  });

  it("NEVER solves a CAPTCHA — even with an approval", () => {
    const d = decideBrowserStep({
      tool: "click",
      target: "https://example.com",
      caps: ENABLED,
      usage: ZERO_USAGE,
      approved: true,
      captcha: true,
    });
    expect(d.decision).toBe("forbidden");
    expect(d.reason).toMatch(/CAPTCHA/);
  });

  describe("domain lists", () => {
    const caps = resolveBrowserCaps({
      enabled: true,
      allowlist: ["example.com", "*.docs.io"],
      denylist: ["evil.com"],
    });

    it("blocks a denylisted domain for reads AND writes (denylist beats allowlist)", () => {
      const read = decideBrowserStep({ tool: "navigate", target: "https://evil.com", caps, usage: ZERO_USAGE });
      expect(read.decision).toBe("deny");
      expect(read.reason).toMatch(/denylist/);
    });

    it("allows a navigation to an allowlisted domain", () => {
      expect(decideBrowserStep({ tool: "navigate", target: "https://example.com/x", caps, usage: ZERO_USAGE }).decision).toBe("allow");
      expect(decideBrowserStep({ tool: "navigate", target: "https://api.docs.io", caps, usage: ZERO_USAGE }).decision).toBe("allow");
    });

    it("denies a navigation to a domain not on the allowlist", () => {
      const d = decideBrowserStep({ tool: "navigate", target: "https://other.com", caps, usage: ZERO_USAGE });
      expect(d.decision).toBe("deny");
      expect(d.reason).toMatch(/allowlist/);
    });

    it("an empty allowlist (default) restricts nothing — reads anywhere not denied are free", () => {
      const d = decideBrowserStep({ tool: "navigate", target: "https://anywhere.net", caps: ENABLED, usage: ZERO_USAGE });
      expect(d.decision).toBe("allow");
    });

    it("exempts about:blank from the allowlist parse-deny (the initial page is not a navigation)", () => {
      // With an allowlist set, a read on the fresh session's about:blank page must NOT be denied as
      // an "unparseable navigation target".
      const d = decideBrowserStep({ tool: "read_page", target: "about:blank", caps, usage: ZERO_USAGE });
      expect(d.decision).toBe("allow");
    });
  });

  describe("per-session caps (0 = unlimited)", () => {
    it("denies a navigation once the page cap is reached", () => {
      const caps = resolveBrowserCaps({ enabled: true, maxPages: 3 });
      const usage: BrowserUsage = { pages: 3, bytes: 0, elapsedMs: 0 };
      const nav = decideBrowserStep({ tool: "navigate", target: "https://example.com", caps, usage });
      expect(nav.decision).toBe("deny");
      expect(nav.reason).toMatch(/page cap/);
      // A non-page tool still works while only the page cap is hit.
      expect(decideBrowserStep({ tool: "read_page", caps, usage }).decision).toBe("allow");
    });

    it("denies every tool once the wall-clock cap is reached", () => {
      const caps = resolveBrowserCaps({ enabled: true, maxWallClockSeconds: 30 });
      const usage: BrowserUsage = { pages: 0, bytes: 0, elapsedMs: 30_000 };
      expect(decideBrowserStep({ tool: "read_page", caps, usage }).decision).toBe("deny");
      expect(decideBrowserStep({ tool: "navigate", target: "https://example.com", caps, usage }).reason).toMatch(/wall-clock/);
    });

    it("denies every tool once the bandwidth cap is reached", () => {
      const caps = resolveBrowserCaps({ enabled: true, maxBandwidthBytes: 1000 });
      const usage: BrowserUsage = { pages: 0, bytes: 1000, elapsedMs: 0 };
      const d = decideBrowserStep({ tool: "screenshot", caps, usage });
      expect(d.decision).toBe("deny");
      expect(d.reason).toMatch(/bandwidth/);
    });

    it("allows while still under every cap", () => {
      const caps = resolveBrowserCaps({ enabled: true, maxPages: 3, maxWallClockSeconds: 30, maxBandwidthBytes: 1000 });
      const usage: BrowserUsage = { pages: 2, bytes: 999, elapsedMs: 29_999 };
      expect(decideBrowserStep({ tool: "navigate", target: "https://example.com", caps, usage }).decision).toBe("allow");
    });
  });
});
