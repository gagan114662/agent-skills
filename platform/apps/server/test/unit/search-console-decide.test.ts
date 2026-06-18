/**
 * Pure Search Console decide tests (#265). No DB, no network. Proves the three premortem properties:
 *  §6 the plan is same-origin-locked and injection-sanitised (foreign URLs dropped, control chars stripped);
 *  §2 verification is accepted ONLY when Search Console confirms presence with zero errors (never assumed);
 *     and a null / unparseable coverage response yields null (never a fabricated count).
 */
import { describe, expect, it } from "vitest";
import {
  decideCoverageReading,
  decideSitemapSubmission,
  decideSitemapVerification,
  isSameOrigin,
  originOf,
} from "../../src/search-console/decide.js";

describe("originOf / isSameOrigin", () => {
  it("requires an absolute https URL", () => {
    expect(originOf("https://ipop.ai/blog")).toBe("https://ipop.ai");
    expect(originOf("http://ipop.ai")).toBeNull(); // not https
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("not a url")).toBeNull();
    expect(originOf("ipop.ai")).toBeNull();
  });

  it("locks to the exact origin", () => {
    expect(isSameOrigin("https://ipop.ai/sitemap.xml", "https://ipop.ai")).toBe(true);
    expect(isSameOrigin("https://evil.com/sitemap.xml", "https://ipop.ai")).toBe(false);
    expect(isSameOrigin("https://ipop.ai.evil.com/x", "https://ipop.ai")).toBe(false);
  });
});

describe("decideSitemapSubmission", () => {
  it("rejects a missing or non-https site URL", () => {
    expect(decideSitemapSubmission({})).toEqual({ ok: false, reason: "siteUrl is required" });
    expect(decideSitemapSubmission({ siteUrl: "http://ipop.ai" })).toMatchObject({ ok: false });
    expect(decideSitemapSubmission({ siteUrl: "ipop.ai" })).toMatchObject({ ok: false });
  });

  it("defaults the sitemap to {origin}/sitemap.xml and scopes to the origin", () => {
    const res = decideSitemapSubmission({ siteUrl: "https://ipop.ai/some/path" });
    expect(res).toEqual({
      ok: true,
      plan: { siteUrl: "https://ipop.ai", sitemapUrl: "https://ipop.ai/sitemap.xml", indexingUrls: [] },
    });
  });

  it("accepts an explicit same-origin sitemap but rejects a foreign one", () => {
    expect(
      decideSitemapSubmission({ siteUrl: "https://ipop.ai", sitemapUrl: "https://ipop.ai/sitemap_index.xml" }),
    ).toMatchObject({ ok: true, plan: { sitemapUrl: "https://ipop.ai/sitemap_index.xml" } });
    expect(
      decideSitemapSubmission({ siteUrl: "https://ipop.ai", sitemapUrl: "https://evil.com/sitemap.xml" }),
    ).toEqual({ ok: false, reason: "sitemapUrl must be on the same origin as siteUrl" });
  });

  it("drops foreign / garbage indexing URLs and dedupes the same-origin ones (injection defense §6)", () => {
    const res = decideSitemapSubmission({
      siteUrl: "https://ipop.ai",
      urls: [
        "https://ipop.ai/blog/a",
        "https://ipop.ai/blog/a", // dup
        "https://evil.com/x", // foreign → dropped
        "http://ipop.ai/insecure", // not https → dropped
        12345, // not a string → dropped
        "https://ipop.ai/blog/b",
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plan.indexingUrls).toEqual(["https://ipop.ai/blog/a", "https://ipop.ai/blog/b"]);
    }
  });

  it("strips control characters from a sitemap URL before the same-origin check", () => {
    const dirty = `https://ipop.ai/sitemap.xml${String.fromCharCode(7)}`;
    const res = decideSitemapSubmission({ siteUrl: "https://ipop.ai", sitemapUrl: dirty });
    expect(res).toMatchObject({ ok: true, plan: { sitemapUrl: "https://ipop.ai/sitemap.xml" } });
  });

  it("bounds the indexing URL list", () => {
    const many = Array.from({ length: 250 }, (_, i) => `https://ipop.ai/p/${i}`);
    const res = decideSitemapSubmission({ siteUrl: "https://ipop.ai", urls: many });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.plan.indexingUrls).toHaveLength(100);
  });
});

describe("decideSitemapVerification (§2 — confirmed, never assumed)", () => {
  it("a null response is honestly not-accepted, not-pending, zero counts", () => {
    expect(decideSitemapVerification("https://ipop.ai/sitemap.xml", null)).toEqual({
      sitemapUrl: "https://ipop.ai/sitemap.xml",
      accepted: false,
      isPending: false,
      errors: 0,
      warnings: 0,
      submittedUrls: 0,
      indexedUrls: 0,
      lastDownloadedMs: null,
    });
  });

  it("accepts only when the sitemap is present with zero errors", () => {
    const accepted = decideSitemapVerification("https://ipop.ai/sitemap.xml", {
      path: "https://ipop.ai/sitemap.xml",
      lastSubmitted: "2026-06-18T00:00:00Z",
      lastDownloaded: "2026-06-18T01:00:00Z",
      errors: 0,
      warnings: 2,
      isPending: false,
      contents: [{ type: "web", submitted: 42, indexed: 30 }],
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.submittedUrls).toBe(42);
    expect(accepted.indexedUrls).toBe(30);
    expect(accepted.warnings).toBe(2);
    expect(accepted.lastDownloadedMs).toBe(Date.parse("2026-06-18T01:00:00Z"));
  });

  it("is NOT accepted when Search Console reports errors", () => {
    const v = decideSitemapVerification("https://ipop.ai/sitemap.xml", {
      path: "https://ipop.ai/sitemap.xml",
      errors: 3,
    });
    expect(v.accepted).toBe(false);
    expect(v.errors).toBe(3);
  });

  it("is NOT accepted when the sitemap is absent from Search Console (still pending)", () => {
    const v = decideSitemapVerification("https://ipop.ai/sitemap.xml", { isPending: "true" });
    expect(v.accepted).toBe(false);
    expect(v.isPending).toBe(true);
  });

  it("coerces hostile string counts and never throws", () => {
    const v = decideSitemapVerification("https://ipop.ai/sitemap.xml", {
      path: "x",
      errors: "0",
      warnings: "not-a-number",
      contents: [{ submitted: "10", indexed: -5 }, "garbage", null],
    });
    expect(v.accepted).toBe(true);
    expect(v.warnings).toBe(0);
    expect(v.submittedUrls).toBe(10);
    expect(v.indexedUrls).toBe(0); // negative clamped away
  });
});

describe("decideCoverageReading (§2 — null, never fabricated)", () => {
  it("returns null for a null or empty response", () => {
    expect(decideCoverageReading(null, 1_700_000_000_000)).toBeNull();
    expect(decideCoverageReading({}, 1_700_000_000_000)).toBeNull();
  });

  it("returns null for an unparseable count", () => {
    expect(decideCoverageReading({ indexedPages: "lots" }, 1)).toBeNull();
    expect(decideCoverageReading({ indexedPages: -1 }, 1)).toBeNull();
  });

  it("reads a real count stamped at now", () => {
    expect(decideCoverageReading({ indexedPages: 18 }, 1_700_000_000_000)).toEqual({
      indexedPages: 18,
      observedAtMs: 1_700_000_000_000,
    });
    expect(decideCoverageReading({ indexedPages: "7" }, 5)).toEqual({ indexedPages: 7, observedAtMs: 5 });
  });
});
