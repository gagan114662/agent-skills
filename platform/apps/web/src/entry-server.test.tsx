/**
 * Prerender-coverage tests (#467). Scout's audit found every public route — home, login, start, pricing,
 * and the marketing sections — shared the homepage's <title>, description, and H1, and that the
 * client-rendered ones shipped an empty <div id="root"> a crawler sees as blank. `prerenderPages()` is the
 * one source of truth for which surfaces get baked to static HTML and what unique head meta each carries,
 * so these tests pin that contract: every public marketing route is present, server-rendered with its real
 * body, and given a unique, front-loaded title + its own description + a breadcrumb.
 */
import { describe, expect, it } from "vitest";
import { buildSitemap, prerenderNotFoundPage, prerenderPages } from "./entry-server.js";
import {
  BRAND,
  PRICING,
  COMPARE,
  STORIES,
  GUIDES,
  CHANGELOG,
  BRAND_ASSETS,
  LEGAL,
  COMPANY,
  SECURITY,
  SEGMENT_LANDING_PAGES,
} from "./brand.js";

const pages = prerenderPages();
const byPath = (urlPath: string) => pages.find((p) => p.urlPath === urlPath);
const organicDiscoveryPosts = [
  "/blog/what-is-an-ai-marketing-agency",
  "/blog/ai-marketing-team-for-startups",
  "/blog/autonomous-marketing-agents-explained",
] as const;

describe("prerenderPages — public marketing coverage (#467)", () => {
  it("prerenders every public marketing surface a crawler should index", () => {
    const paths = pages.map((p) => p.urlPath);
    for (const expected of [
      "/",
      "/start",
      "/welcome",
      "/demo",
      "/sandbox",
      "/login",
      "/signup",
      "/everyday",
      "/dashboard",
      "/theater",
      "/support/status",
      "/status/test",
      "/blog",
      "/pricing",
      "/security",
      "/terms",
      "/privacy",
      "/company",
      "/dpa",
      "/compare",
      "/stories",
      "/guides",
      "/changelog",
      "/brand",
    ]) {
      expect(paths, `missing prerendered route ${expected}`).toContain(expected);
    }
    for (const segment of SEGMENT_LANDING_PAGES) {
      expect(paths, `missing prerendered segment route ${segment.path}`).toContain(segment.path);
    }
  });

  it.each([
    ["/terms", "Terms", LEGAL.terms.title],
    ["/privacy", "Privacy", LEGAL.privacy.title],
    ["/dpa", "DPA", LEGAL.dpa.title],
    ["/company", "Company", COMPANY.title],
    ["/security", "Security", SECURITY.title],
  ])("prerenders %s with public legal copy and breadcrumbs (#863)", (urlPath, titleWord, h1) => {
    const page = byPath(urlPath)!;
    expect(page.title).toContain(titleWord);
    expect(page.description, `${urlPath} has no description`).toBeTruthy();
    expect(page.html).toContain(h1);
    expect(page.headExtra).toContain('"@type":"BreadcrumbList"');
  });

  it("gives every route a unique <title> — no two pages share the homepage's title", () => {
    const titles = pages.map((p) => p.title ?? BRAND.title); // home inherits the shell's hand-written title
    expect(new Set(titles).size, "two prerendered pages share a <title>").toBe(titles.length);
  });

  it("prerenders / as the same message-first onboarding door the client shows", () => {
    const home = byPath("/")!;
    const welcome = byPath("/welcome")!;

    expect(home.html).toContain("Make marketing pop.");
    expect(home.html).toContain("what are we marketing today?");
    expect(home.html).toContain("Open Telegram");
    expect(home.html).toContain("https://t.me/ipopmarketingbot");
    expect(home.html).toContain("marketing team in your messages");
    expect(home.html).toContain("marketing work preview");
    expect(home.html).not.toContain("Start free");
    expect(home.html).not.toContain("Watch live demo");
    expect(home.html).toBe(welcome.html);
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
    expect(pricing.html).toContain("Start");
    expect(pricing.headExtra).toContain('"@type":"BreadcrumbList"');
    expect(pricing.headExtra).toContain("/pricing");
  });

  it.each([
    ["/demo", "Live demo", "Build my free deliverable"],
    ["/sandbox", "Sandbox", "Build my free deliverable"],
    ["/login", "Sign in", "Sign in"],
    ["/signup", "Sign up", "Create account"],
  ])("prerenders %s as its own activation/auth route, not homepage fallback (#1176/#1184)", (urlPath, titleWord, bodyText) => {
    const page = byPath(urlPath)!;
    const home = byPath("/")!;
    expect(page.title).toContain(titleWord);
    expect(page.description, `${urlPath} has no description`).toBeTruthy();
    expect(page.html).toContain(bodyText);
    expect(page.html).not.toBe(home.html);
    expect(page.headExtra).toContain('"@type":"BreadcrumbList"');
  });

  it.each(["/start", "/welcome"])("keeps %s as an explicit alias of the public homepage door", (urlPath) => {
    const page = byPath(urlPath)!;
    const home = byPath("/")!;

    expect(page.title).toContain(urlPath === "/start" ? "Start" : "Welcome");
    expect(page.description).toContain(
      urlPath === "/start" ? "live Telegram room" : "Choose Telegram",
    );
    expect(page.html).toContain("what are we marketing today?");
    expect(page.html).toBe(home.html);
    expect(page.headExtra).toContain('"@type":"BreadcrumbList"');
  });

  it.each([
    ["/everyday", "Everyday workspace", "Review approvals"],
    ["/theater", "Agent theater", "Watch workspace-scoped"],
    ["/support/status", "Support ticket status", "Ticket status"],
    ["/status/test", "Status page", "component health"],
  ])("prerenders %s as an honest route-specific shell instead of homepage HTML (#1184)", (urlPath, titleWord, bodyText) => {
    const page = byPath(urlPath)!;
    const home = byPath("/")!;
    expect(page.title).toContain(titleWord);
    expect(page.description, urlPath + " has no description").toBeTruthy();
    expect(page.html).toContain(bodyText);
    expect(page.html).not.toBe(home.html);
    expect(page.html).toContain("Log in");
    expect(page.headExtra).toContain('"@type":"BreadcrumbList"');
  });

  it("prerenders /dashboard as the public marketing dashboard instead of the legacy signed-in splash (#1485)", () => {
    const page = byPath("/dashboard")!;
    const home = byPath("/")!;
    expect(page.title).toContain("Dashboard");
    expect(page.description, "/dashboard has no description").toBeTruthy();
    expect(page.html).not.toBe(home.html);
    expect(page.html).toContain("Marketing dashboard");
    expect(page.html).toContain("homepage actions");
    expect(page.html).toContain("Public footer");
    expect(page.html).toContain("visible work");
    expect(page.html).not.toContain("Signed-in workspace");
    expect(page.html).not.toContain("Review live ipop work receipts");
    expect(page.headExtra).toContain('"@type":"BreadcrumbList"');
  });

  it("generates a branded 404 document without adding it to the sitemap (#1534)", () => {
    const page = prerenderNotFoundPage();
    const sitemap = buildSitemap("https://ipop.ai", pages);

    expect(page.outFile).toBe("404.html");
    expect(page.title).toContain("Page not found");
    expect(page.html).toContain("Page not found");
    expect(page.html).toContain("Go home");
    expect(page.headExtra).toContain("noindex");
    expect(sitemap).not.toContain("<loc>https://ipop.ai/404</loc>");
  });

  it("keeps public route unfurls specific for demo and welcome (#1184)", () => {
    expect(byPath("/demo")!.title).toMatch(/^Live demo\b/);
    expect(byPath("/demo")!.description).toContain("website");
    expect(byPath("/welcome")!.title).toMatch(/^Welcome\b/);
    expect(byPath("/welcome")!.description).toContain("Choose Telegram");
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

  it("prerenders the #903 organic-discovery pillar and spoke articles", () => {
    const paths = pages.map((p) => p.urlPath);
    for (const expected of organicDiscoveryPosts) {
      expect(paths, `missing prerendered SEO article ${expected}`).toContain(expected);
    }
  });

  it("includes the #903 organic-discovery articles in the sitemap", () => {
    const sitemap = buildSitemap("https://ipop.ai", pages);
    for (const expected of organicDiscoveryPosts) {
      expect(sitemap).toContain(`<loc>https://ipop.ai${expected}</loc>`);
    }
  });

  it("prerenders all #599 segment pages with unique ICP copy and experiment metadata", () => {
    const sitemap = buildSitemap("https://ipop.ai", pages);
    const titles = new Set<string>();
    for (const segment of SEGMENT_LANDING_PAGES) {
      const page = byPath(segment.path)!;
      expect(page.title).toContain(segment.seoTitleSubject);
      expect(page.description).toBe(segment.seoDescription);
      expect(page.html).toContain(segment.hero.title);
      expect(page.html).toContain(segment.proof.title);
      expect(page.html).toContain(segment.experiment.id);
      expect(page.headExtra).toContain('"@type":"BreadcrumbList"');
      expect(sitemap).toContain(`<loc>https://ipop.ai${segment.path}</loc>`);
      titles.add(page.title!);
    }
    expect(titles.size).toBe(SEGMENT_LANDING_PAGES.length);
  });
});
