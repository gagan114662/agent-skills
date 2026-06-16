import { describe, it, expect } from "vitest";
import { normalizeDomain } from "../../src/auth/onboarding-domain.js";

describe("normalizeDomain (#260)", () => {
  it("accepts a bare domain and derives url + slug", () => {
    expect(normalizeDomain("acme.com")).toEqual({
      ok: true,
      domain: "acme.com",
      url: "https://acme.com",
      slug: "acme-com",
    });
  });

  it("strips scheme, www, path, query, port, and lowercases + trims", () => {
    for (const input of [
      "https://www.Acme.com/pricing?x=1",
      "  HTTP://ACME.COM:8080/  ",
      "www.acme.com",
      "acme.com/",
    ]) {
      const r = normalizeDomain(input);
      expect(r.ok, input).toBe(true);
      if (r.ok) expect(r.domain, input).toBe("acme.com");
    }
  });

  it("keeps multi-label hosts (subdomains other than www) and builds a safe slug", () => {
    const r = normalizeDomain("shop.acme.co.uk");
    expect(r).toEqual({
      ok: true,
      domain: "shop.acme.co.uk",
      url: "https://shop.acme.co.uk",
      slug: "shop-acme-co-uk",
    });
  });

  it("rejects empty, whitespace-only, and non-domain input", () => {
    for (const bad of ["", "   ", "not a domain", "localhost", "http://", "acme", "acme."]) {
      expect(normalizeDomain(bad).ok, bad).toBe(false);
    }
  });
});
