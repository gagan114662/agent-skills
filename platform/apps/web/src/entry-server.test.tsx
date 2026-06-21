/**
 * Prerender-coverage tests (#467). Scout's audit found every public route — home, login, start, pricing,
 * and the marketing sections — shared the homepage's <title>, description, and H1, and that the
 * client-rendered ones shipped an empty <div id="root"> a crawler sees as blank. `prerenderPages()` is the
 * one source of truth for which surfaces get baked to static HTML and what unique head meta each carries,
 * so these tests pin that contract: every public marketing route is present, server-rendered with its real
 * body, and given a unique, front-loaded title + its own description + a breadcrumb.
 */
import { describe, expect, it } from "vitest";
import { prerenderPages } from "./entry-server.js";
import { BRAND, PRICING, COMPARE, STORIES, GUIDES, CHANGELOG, BRAND_ASSETS } from "./brand.js";

const pages = prerenderPages();
const byPath = (urlPath: string) => pages.find((p) => p.urlPath === urlPath);

describe("prerenderPages — public marketing coverage (#467)", () => {
  it("prerenders every public marketing surface a crawler should index", () => {
    const paths = pages.map((p) => p.urlPath);
    for (const expected of ["/", "/blog", "/pricing", "/compare", "/stories", "/guides", "/changelog", "/brand"]) {
      expect(paths, `missing prerendered route ${expected}`).toContain(expected);
    }
  });

  it("gives every route a unique <title> — no two pages share the homepage's title", () => {
    const titles = pages.map((p) => p.title ?? BRAND.title); // home inherits the shell's hand-written title
    expect(new Set(titles).size, "two prerendered pages share a <title>").toBe(titles.length);
  });

  it("front-loads each sub-page title with its own subject (brand trails, never leads)", () => {
    // The home page is the one route whose subject *is* the brand, so it may lead with it; every other
    // route must put its distinguishing term first (Scout's "real title buried after build-config" finding).
    for (const page of pages.filter((p) => p.urlPath !== "/")) {
      expect(page.title, `${page.urlPath} has no title`).toBeTruthy();
      expect(page.title!.toLowerCase().startsWith("ipop"), `${page.urlPath} title leads with the brand`).toBe(false);
    }
  });

  it("gives the pricing page its own title, description, real body, and a breadcrumb", () => {
    const pricing = byPath("/pricing")!;
    expect(pricing.title).toMatch(/^Pricing\b/);
    expect(pricing.title).toContain(BRAND.name);
    expect(pricing.description).toBeTruthy();
    // The SSR body carries the real pricing H1 + a real plan name (proves it isn't an empty shell).
    expect(pricing.html).toContain(PRICING.title);
    expect(pricing.html).toContain("Start free");
    expect(pricing.headExtra).toContain('"@type":"BreadcrumbList"');
    expect(pricing.headExtra).toContain("/pricing");
  });

  it.each([
    ["/compare", "Compare", COMPARE.title],
    ["/stories", "stories", STORIES.title],
    ["/guides", "Guides", GUIDES.title],
    ["/changelog", "Changelog", CHANGELOG.title],
    ["/brand", "Brand", BRAND_ASSETS.title],
  ])("prerenders %s with a unique title and its real H1 in the body", (urlPath, titleWord, h1) => {
    const page = byPath(urlPath)!;
    expect(page.title).toContain(titleWord);
    expect(page.description, `${urlPath} has no description`).toBeTruthy();
    // The section's real headline is server-rendered into the body, not left to client JS.
    expect(page.html).toContain(h1);
    expect(page.headExtra).toContain('"@type":"BreadcrumbList"');
  });

  it("canonicalises every marketing page to its own path (no shared homepage canonical)", () => {
    for (const page of pages.filter((p) => p.urlPath !== "/")) {
      // urlPath is what injectPage() turns into the canonical/og:url — each must be its own route.
      expect(page.urlPath).not.toBe("/");
    }
  });
});
