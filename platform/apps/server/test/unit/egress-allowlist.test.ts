import { describe, it, expect } from "vitest";
import {
  domainOf,
  matchesAllowlist,
  decideEgress,
  normaliseAllowlist,
  resolveEgressPolicy,
} from "../../src/runtime/egress-allowlist.js";

describe("egress-allowlist (#151 — per-workspace domain allowlist)", () => {
  describe("domainOf", () => {
    it("extracts the host from a full URL, stripping scheme/path/query/port", () => {
      expect(domainOf("https://api.example.com:443/v1/x?y=1")).toBe("api.example.com");
    });
    it("handles a bare host and a host:port", () => {
      expect(domainOf("example.com")).toBe("example.com");
      expect(domainOf("example.com:8080")).toBe("example.com");
    });
    it("strips userinfo and a trailing FQDN dot, lower-cases", () => {
      expect(domainOf("https://user:pw@API.Example.com./path")).toBe("api.example.com");
    });
    it("keeps a bracketed IPv6 host", () => {
      expect(domainOf("http://[2001:db8::1]:8080/x")).toBe("[2001:db8::1]");
    });
    it("returns null for empty/garbage", () => {
      expect(domainOf("")).toBeNull();
      expect(domainOf("   ")).toBeNull();
    });
  });

  describe("matchesAllowlist", () => {
    it("matches exact entries", () => {
      expect(matchesAllowlist("api.example.com", ["api.example.com"])).toBe(true);
      expect(matchesAllowlist("evil.com", ["api.example.com"])).toBe(false);
    });
    it("matches leading-wildcard subdomains but not the apex", () => {
      expect(matchesAllowlist("a.example.com", ["*.example.com"])).toBe(true);
      expect(matchesAllowlist("deep.a.example.com", ["*.example.com"])).toBe(true);
      expect(matchesAllowlist("example.com", ["*.example.com"])).toBe(false);
    });
    it("is case-insensitive and tolerates blank/whitespace entries", () => {
      expect(matchesAllowlist("API.Example.com", [" ", "api.example.com "])).toBe(true);
    });
  });

  describe("decideEgress", () => {
    const allowlist = ["api.example.com", "*.analytics.io"];

    it("default-OFF allows every target (today's behavior)", () => {
      expect(decideEgress({ target: "https://evil.com", allowlist: [], enabled: false }).decision).toBe(
        "allow",
      );
    });
    it("enabled: allows a listed domain", () => {
      expect(decideEgress({ target: "https://api.example.com/x", allowlist, enabled: true }).decision).toBe(
        "allow",
      );
      expect(decideEgress({ target: "https://eu.analytics.io", allowlist, enabled: true }).decision).toBe(
        "allow",
      );
    });
    it("enabled: denies an unlisted domain", () => {
      const d = decideEgress({ target: "https://stripe.com/charge", allowlist, enabled: true });
      expect(d.decision).toBe("deny");
      expect(d.domain).toBe("stripe.com");
      expect(d.reason).toMatch(/allowlist/);
    });
    it("enabled: flags an unparseable target rather than silently allowing it", () => {
      const d = decideEgress({ target: "   ", allowlist, enabled: true });
      expect(d.decision).toBe("flagged");
      expect(d.domain).toBeNull();
    });
  });

  describe("resolveEgressPolicy / normaliseAllowlist", () => {
    it("defaults to OFF with an empty allowlist", () => {
      expect(resolveEgressPolicy(undefined)).toEqual({ enabled: false, allowlist: [] });
    });
    it("normalises: trims, lower-cases, dedupes, drops blanks", () => {
      expect(normaliseAllowlist([" API.com ", "api.com", "", "  "])).toEqual(["api.com"]);
    });
    it("carries enabled + a normalised allowlist through", () => {
      expect(resolveEgressPolicy({ enabled: true, allowlist: ["A.com", "a.com"] })).toEqual({
        enabled: true,
        allowlist: ["a.com"],
      });
    });
  });
});
