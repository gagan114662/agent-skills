/**
 * SEO/prerender helper tests (#252): the pure HTML injection + sitemap/robots generation that turns a
 * client-rendered shell into indexable static pages.
 */
import { describe, expect, it } from "vitest";
import {
  resolveOrigin,
  canonicalUrl,
  injectPage,
  buildSitemap,
  buildRobots,
  type PrerenderPage,
} from "./seo.js";

// Mirrors the real built index.html shell: a head comment that mentions the literal "<title>" (which a
// naive title-replace would corrupt) and a multi-line description meta (which a single-line regex would
// miss). Keeping the test shell faithful to the real one is what makes these regressions catchable.
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <!-- Static SEO defaults for crawlers. brand.ts/applyBrand() refines the <title> from
         VITE_BRAND_TITLE at runtime for the app shell; these tags are what link unfurlers read. -->
    <title>ipop — your marketing agency of AI agents</title>
    <meta
      name="description"
      content="default description"
    />
    <link rel="canonical" href="https://ipop.ai/" />
    <meta property="og:title" content="ipop" />
    <meta property="og:description" content="og default" />
    <meta property="og:url" content="https://ipop.ai/" />
    <meta name="twitter:title" content="ipop" />
    <meta name="twitter:description" content="tw default" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/index.js"></script>
  </body>
</html>`;

describe("resolveOrigin", () => {
  it("defaults to https://ipop.ai and honours SITE_ORIGIN, stripping trailing slashes", () => {
    expect(resolveOrigin({})).toBe("https://ipop.ai");
    expect(resolveOrigin({ SITE_ORIGIN: "https://preview.example.com/" })).toBe("https://preview.example.com");
  });
});

describe("canonicalUrl", () => {
  it("keeps the home trailing slash and joins sub-paths", () => {
    expect(canonicalUrl("https://ipop.ai", "/")).toBe("https://ipop.ai/");
    expect(canonicalUrl("https://ipop.ai", "/blog")).toBe("https://ipop.ai/blog");
    expect(canonicalUrl("https://ipop.ai", "/blog/post")).toBe("https://ipop.ai/blog/post");
  });
});

describe("injectPage", () => {
  const origin = "https://ipop.ai";

  it("injects the SSR body into #root", () => {
    const page: PrerenderPage = { outFile: "index.html", urlPath: "/", html: "<h1>Real headline</h1>" };
    const out = injectPage(SHELL, page, origin);
    expect(out).toContain('<div id="root"><h1>Real headline</h1></div>');
    expect(out).not.toContain('<div id="root"></div>');
  });

  it("keeps the shell's head meta for the home page (no overrides)", () => {
    const page: PrerenderPage = { outFile: "index.html", urlPath: "/", html: "<h1>Home</h1>" };
    const out = injectPage(SHELL, page, origin);
    expect(out).toContain("<title>ipop — your marketing agency of AI agents</title>");
    expect(out).toContain('<link rel="canonical" href="https://ipop.ai/" />');
  });

  it("rewrites title / description / canonical / OG / Twitter for a blog post", () => {
    const page: PrerenderPage = {
      outFile: "blog/post/index.html",
      urlPath: "/blog/post",
      html: "<article>Body</article>",
      title: "My Post — ipop",
      description: "A specific post description.",
    };
    const out = injectPage(SHELL, page, origin);
    expect(out).toContain("<title>My Post — ipop</title>");
    // The head comment that mentions the literal "<title>" must survive intact (regression guard).
    expect(out).toContain("refines the <title> from");
    // Exactly one real title element (the comment's "<title>" is not a closing-tagged element).
    expect(out.match(/<title>[^<]*<\/title>/g)).toHaveLength(1);
    // The multi-line description meta is rewritten in place.
    expect(out).toMatch(/name="description"\s+content="A specific post description\."/);
    expect(out).toContain('<link rel="canonical" href="https://ipop.ai/blog/post" />');
    expect(out).toContain('<meta property="og:url" content="https://ipop.ai/blog/post" />');
    expect(out).toContain('<meta property="og:title" content="My Post — ipop" />');
    expect(out).toContain('<meta property="og:description" content="A specific post description." />');
    expect(out).toContain('<meta name="twitter:title" content="My Post — ipop" />');
  });

  it("escapes special characters in injected meta", () => {
    const page: PrerenderPage = {
      outFile: "blog/x/index.html",
      urlPath: "/blog/x",
      html: "<p>x</p>",
      title: 'Tom & "Jerry" <tag>',
    };
    const out = injectPage(SHELL, page, origin);
    expect(out).toContain("<title>Tom &amp; &quot;Jerry&quot; &lt;tag&gt;</title>");
  });
});

describe("buildSitemap", () => {
  it("lists every page with absolute locs, lastmod, and priority", () => {
    const pages: PrerenderPage[] = [
      { outFile: "index.html", urlPath: "/", html: "", priority: 1.0 },
      { outFile: "blog/index.html", urlPath: "/blog", html: "", priority: 0.8 },
      { outFile: "blog/p/index.html", urlPath: "/blog/p", html: "", lastmod: "2026-06-14", priority: 0.7 },
    ];
    const xml = buildSitemap("https://ipop.ai", pages);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<loc>https://ipop.ai/</loc>");
    expect(xml).toContain("<loc>https://ipop.ai/blog</loc>");
    expect(xml).toContain("<loc>https://ipop.ai/blog/p</loc>");
    expect(xml).toContain("<lastmod>2026-06-14</lastmod>");
    expect(xml).toContain("<priority>1.0</priority>");
  });
});

describe("buildRobots", () => {
  it("allows all and points at the sitemap", () => {
    const robots = buildRobots("https://ipop.ai");
    expect(robots).toMatch(/User-agent: \*/);
    expect(robots).toMatch(/Allow: \//);
    expect(robots).toContain("Sitemap: https://ipop.ai/sitemap.xml");
  });
});
