import { describe, it, expect } from "vitest";
import { renderHostedPage, escapeHtml } from "../../src/hosted/render.js";
import { resolveHostedUrl, resolveHostedHost, isValidCustomDomain } from "../../src/hosted/domain.js";

/**
 * #266 — production-grounded render proof. The renderer is the injection chokepoint (premortem #200 §6):
 * user-supplied title/body/description are DATA and must NEVER become live markup, script, or an attribute
 * break-out. These tests assert the document is a real, complete, servable HTML page AND that hostile
 * payloads are neutralised.
 */
describe("hosted/render — injection defense", () => {
  const base = {
    site: { name: "Acme" },
    url: "https://acme.example.com/post",
  };

  it("escapes a <script> payload in the body — no live tag survives", () => {
    const html = renderHostedPage({
      ...base,
      page: { kind: "article", title: "T", slug: "post", body: "<script>alert(1)</script>" },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("neutralises a </script> break-out inside the JSON-LD block", () => {
    const html = renderHostedPage({
      ...base,
      page: {
        kind: "article",
        title: "Pwn </script><script>evil()</script>",
        slug: "post",
        body: "hi",
      },
    });
    // The only real <script> tags are the JSON-LD block(s) we emit — never one from the title.
    expect(html).not.toContain("<script>evil()</script>");
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("escapes an attribute break-out attempt in the title (no quote escape into <meta>)", () => {
    const html = renderHostedPage({
      ...base,
      page: { kind: "article", title: '"><img src=x onerror=evil>', slug: "post", body: "b" },
    });
    expect(html).not.toContain('"><img src=x onerror=evil>');
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("escapeHtml covers the five HTML-significant characters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});

describe("hosted/render — a real, servable document", () => {
  it("emits a complete HTML document with canonical, OG, and JSON-LD", () => {
    const url = "https://acme.example.com/launch-day";
    const html = renderHostedPage({
      site: { name: "Acme" },
      url,
      page: {
        kind: "article",
        title: "Launch Day",
        slug: "launch-day",
        body: "Para one.\n\nPara two.",
        description: "We launched.",
        publishedAt: "2026-06-17T10:00:00.000Z",
      },
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("<title>Launch Day — Acme</title>");
    expect(html).toContain(`<link rel="canonical" href="${url}" />`);
    expect(html).toContain('<meta property="og:type" content="article" />');
    expect(html).toContain('"@type":"BlogPosting"');
    expect(html).toContain("<p>Para one.</p>");
    expect(html).toContain("<p>Para two.</p>");
    // well-formed enough that every opened structural tag closes
    expect(html).toContain("</html>");
    expect(html.trim().endsWith("</html>")).toBe(true);
  });

  it("renders a landing page as a WebPage section", () => {
    const html = renderHostedPage({
      site: { name: "Acme" },
      url: "https://acme.example.com/home",
      page: { kind: "landing", title: "Home", slug: "home", body: "Welcome." },
    });
    expect(html).toContain('"@type":"WebPage"');
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).toContain("<section");
  });

  it("is deterministic — identical input yields identical bytes", () => {
    const input = {
      site: { name: "Acme" },
      url: "https://acme.example.com/x",
      page: { kind: "article" as const, title: "X", slug: "x", body: "y" },
    };
    expect(renderHostedPage(input)).toBe(renderHostedPage(input));
  });
});

describe("hosted/domain — public URL resolution", () => {
  it("serves a verified custom domain, else the ipop subdomain", () => {
    expect(resolveHostedHost({ subdomain: "acme", customDomain: "acme.com", domainVerified: true })).toBe(
      "acme.com",
    );
    expect(resolveHostedHost({ subdomain: "acme", customDomain: "acme.com", domainVerified: false })).toBe(
      "acme.sites.ipop.app",
    );
    expect(resolveHostedHost({ subdomain: "acme" })).toBe("acme.sites.ipop.app");
  });

  it("builds a canonical URL and refuses an unsafe slug", () => {
    expect(resolveHostedUrl({ subdomain: "acme" }, "launch-day")).toBe(
      "https://acme.sites.ipop.app/launch-day",
    );
    expect(() => resolveHostedUrl({ subdomain: "acme" }, "../escape")).toThrow();
  });

  it("validates custom domains", () => {
    expect(isValidCustomDomain("acme.com")).toBe(true);
    expect(isValidCustomDomain("blog.acme.co.uk")).toBe(true);
    expect(isValidCustomDomain("not a domain")).toBe(false);
    expect(isValidCustomDomain("../evil")).toBe(false);
  });
});
