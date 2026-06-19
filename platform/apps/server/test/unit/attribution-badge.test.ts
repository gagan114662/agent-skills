import { describe, it, expect } from "vitest";
import {
  buildAttributionBadge,
  appendBadge,
  badgeFormatForPath,
} from "../../src/attribution/badge.js";
import {
  mintTrackingRef,
  TRACKING_REF_PARAM,
  TRACKING_REF_PREFIX,
} from "../../src/attribution/tracking.js";

const base = { workspaceId: "ws-1", artifactId: "blog/launch", channel: "builtwith" } as const;

describe("attribution/badge — buildAttributionBadge", () => {
  it("html: label + tracked url with ref + utm, href escaped, in a footer", () => {
    const badge = buildAttributionBadge({ ...base, format: "html" });
    const ref = mintTrackingRef(base);
    expect(badge).toContain("Built with ipop");
    expect(badge).toContain("<footer");
    expect(badge).toContain('rel="noopener"');
    expect(badge).toContain(`${TRACKING_REF_PARAM}=${ref}`);
    expect(badge).toContain("utm_source=builtwith");
    expect(badge).toContain("utm_medium=badge");
    expect(badge).toContain("utm_campaign=builtwith");
    // The href is HTML-escaped (the URL's `&` separators become `&amp;`).
    expect(badge).toContain("&amp;");
    expect(badge).not.toMatch(/href="[^"]*&utm/); // raw unescaped ampersand never leaks into the attribute
  });

  it("markdown: [Built with ipop](TRACKED_URL) with ref + utm", () => {
    const badge = buildAttributionBadge({ ...base, format: "markdown" });
    const ref = mintTrackingRef(base);
    expect(badge.startsWith("[Built with ipop](")).toBe(true);
    expect(badge.endsWith(")")).toBe(true);
    expect(badge).toContain(`${TRACKING_REF_PARAM}=${ref}`);
    expect(badge).toContain("utm_medium=badge");
    // markdown keeps the raw URL (no HTML escaping).
    expect(badge).not.toContain("&amp;");
  });

  it("text: 'Built with ipop: TRACKED_URL' with ref + utm", () => {
    const badge = buildAttributionBadge({ ...base, format: "text" });
    const ref = mintTrackingRef(base);
    expect(badge.startsWith("Built with ipop: https://ipop.ai/")).toBe(true);
    expect(badge).toContain(`${TRACKING_REF_PARAM}=${ref}`);
  });

  it("defaults to ipop.ai + builtwith, and honours baseUrl + utmSource overrides", () => {
    const def = buildAttributionBadge({ ...base, format: "text" });
    expect(def).toContain("https://ipop.ai/");
    expect(def).toContain("utm_source=builtwith");

    const over = buildAttributionBadge({
      ...base,
      format: "text",
      baseUrl: "https://acme.example/pricing",
      utmSource: "ipop",
    });
    expect(over).toContain("https://acme.example/pricing");
    expect(over).toContain("utm_source=ipop");
    // campaign is always the channel
    expect(over).toContain("utm_campaign=builtwith");
  });

  it("is deterministic for the same inputs (idempotent badge)", () => {
    const a = buildAttributionBadge({ ...base, format: "markdown" });
    const b = buildAttributionBadge({ ...base, format: "markdown" });
    expect(a).toBe(b);
    // the ref is ours (carries the tracking prefix)
    expect(a).toContain(`${TRACKING_REF_PREFIX}_`);
  });

  it("differs across artifact / channel (each artifact is its own attributable seed)", () => {
    const a = buildAttributionBadge({ ...base, format: "text" });
    const b = buildAttributionBadge({ ...base, artifactId: "blog/other", format: "text" });
    const c = buildAttributionBadge({ ...base, channel: "seo", format: "text" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("attribution/badge — appendBadge placement", () => {
  it("html: inserts the badge before the LAST </body>", () => {
    const badge = buildAttributionBadge({ ...base, format: "html" });
    const out = appendBadge("<html><body><h1>Hi</h1></body></html>", badge, "html");
    expect(out).toBe(`<html><body><h1>Hi</h1>${badge}</body></html>`);
    expect(out.indexOf(badge)).toBeLessThan(out.indexOf("</body>"));
  });

  it("html: matches </body> case-insensitively", () => {
    const badge = buildAttributionBadge({ ...base, format: "html" });
    const out = appendBadge("<HTML><BODY>x</BODY></HTML>", badge, "html");
    expect(out).toContain(`${badge}</BODY>`);
  });

  it("html: appends at the end when there is no </body>", () => {
    const badge = buildAttributionBadge({ ...base, format: "html" });
    const out = appendBadge("<div>fragment</div>", badge, "html");
    expect(out).toBe(`<div>fragment</div>${badge}`);
  });

  it("markdown / text: appends with a trailing blank line", () => {
    const badge = buildAttributionBadge({ ...base, format: "markdown" });
    expect(appendBadge("body", badge, "markdown")).toBe(`body\n\n${badge}`);
    const tBadge = buildAttributionBadge({ ...base, format: "text" });
    expect(appendBadge("body", tBadge, "text")).toBe(`body\n\n${tBadge}`);
  });
});

describe("attribution/badge — badgeFormatForPath", () => {
  it("maps extensions to formats", () => {
    expect(badgeFormatForPath("content/blog/post.md")).toBe("markdown");
    expect(badgeFormatForPath("Post.MARKDOWN")).toBe("markdown");
    expect(badgeFormatForPath("page.html")).toBe("html");
    expect(badgeFormatForPath("page.HTM")).toBe("html");
    expect(badgeFormatForPath("notes.txt")).toBe("text");
    expect(badgeFormatForPath("no-extension")).toBe("text");
  });
});

// The gate is at the injection-site (the badgeFor seam in default.ts): inactive ⇒ null ⇒ content unchanged.
// We exercise the same shape here with a fake seam so the off→original / on→original+badge contract is pinned.
describe("attribution/badge — gating at the injection boundary (off ⇒ unchanged)", () => {
  type BadgeFor = (i: { workspaceId: string; artifactId: string; format: "markdown" }) => string | null;

  function shipContent(draft: string, badgeFor: BadgeFor): string {
    const badge = badgeFor({ workspaceId: "ws-1", artifactId: "Launch post", format: "markdown" });
    return badge ? appendBadge(draft, badge, "markdown") : draft;
  }

  it("off (badgeFor → null): content is byte-for-byte the original draft", () => {
    const off: BadgeFor = () => null;
    expect(shipContent("# Hello\n\nbody", off)).toBe("# Hello\n\nbody");
  });

  it("on (badgeFor → badge): content gains the appended badge", () => {
    const on: BadgeFor = (i) => buildAttributionBadge({ ...base, ...i });
    const out = shipContent("# Hello\n\nbody", on);
    expect(out.startsWith("# Hello\n\nbody\n\n")).toBe(true);
    expect(out).toContain("[Built with ipop](");
  });
});
