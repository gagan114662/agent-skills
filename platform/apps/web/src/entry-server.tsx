/**
 * The build-time SSR entry (#252). It renders the public marketing surfaces to static HTML so a raw
 * fetch (what a search crawler does first) returns the real headline, sections, and article text —
 * instead of the empty `<div id="root">` a client-rendered SPA ships. `scripts/prerender.mjs` imports
 * this after the normal Vite build, injects each page's body into the built `index.html` shell, and
 * writes the static files (`/index.html`, `/blog/index.html`, `/blog/<slug>/index.html`, `sitemap.xml`,
 * `robots.txt`). The browser then hydrates the full interactive app over the prerendered markup via the
 * existing `main.tsx` (createRoot) — visitors get the identical experience; crawlers get real content.
 *
 * Only `renderToStaticMarkup` is used (no hydration markers): the client mounts with `createRoot`, which
 * cleanly replaces the static markup, so there's no hydration-mismatch risk from the app's async session
 * bootstrap. Components reached here are SSR-safe — every `window`/`document` access lives in effects,
 * which `renderToStaticMarkup` never runs.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { BLOG, BRAND, COMPARE, STORIES, GUIDES, CHANGELOG, PAGE_SEO } from "./brand.js";
import { Landing } from "./components/landing/Landing.js";
import { PricingPage } from "./components/landing/PricingPage.js";
import { RefundPolicy } from "./components/landing/RefundPolicy.js";
import { LegalPage } from "./components/landing/LegalPage.js";
import { CompanyPage } from "./components/landing/CompanyPage.js";
import { SiteShell } from "./components/site/SiteShell.js";
import { SectionPage } from "./components/site/SectionPage.js";
import { Brand } from "./components/site/Brand.js";
import { BlogIndex, BlogPostPage } from "./blog/Blog.js";
import { listPostMeta, type BlogPostMeta } from "./blog/posts.js";
import { hreflangLinks } from "./i18n.js";
import { resolveOrigin, escapeHtml, type PrerenderPage } from "./blog/seo.js";
import {
  organizationLd,
  softwareApplicationLd,
  websiteLd,
  blogLd,
  blogPostingLd,
  breadcrumbLd,
  renderJsonLd,
} from "./blog/structured-data.js";

// Re-export the pure SEO helpers so the prerender build script (scripts/prerender.mjs) can import
// everything it needs from this one built SSR bundle.
export { resolveOrigin, injectPage, buildSitemap, buildRobots } from "./blog/seo.js";
export type { PrerenderPage } from "./blog/seo.js";

// The prerender origin (same resolution the build script uses) so JSON-LD URLs are absolute + canonical.
const ORIGIN = resolveOrigin(typeof process !== "undefined" ? process.env : {});

/** Per-post `<meta property="article:*">` tags (Open Graph article extensions) for a post page. */
function articleMeta(post: BlogPostMeta): string {
  const tags: string[] = [];
  if (post.date) tags.push(`<meta property="article:published_time" content="${escapeHtml(post.date)}" />`);
  tags.push(`<meta property="article:author" content="${escapeHtml(post.author)}" />`);
  return tags.map((t) => `  ${t}`).join("\n");
}

/**
 * The public marketing surfaces beyond the homepage and the blog (#467): the focused pricing page and the
 * five content-site sections (compare / stories / guides / changelog / brand). Before this, every one of
 * these fell through `AuthGate` to the SPA shell — a crawler got an empty `<div id="root">` and the
 * homepage's shared `<title>` / description / H1 (Scout's "all routes share the same title" finding).
 *
 * Each is now rendered to static HTML with its own front-loaded title + description (from `PAGE_SEO`) and a
 * Home › Page breadcrumb. The section indexes' card lists still hydrate from the live content API on the
 * client, but everything a crawler indexes — the headline, the intro copy, the nav, and the footer — is
 * server-rendered here. The body wrappers mirror what the client mounts (`SiteShell` chrome for the content
 * sections; `PricingPage` carries its own nav/footer) so the prerendered markup matches the hydrated page.
 */
function marketingPages(): PrerenderPage[] {
  const body: Record<keyof typeof PAGE_SEO, React.JSX.Element> = {
    "/pricing": <PricingPage />,
    "/refund-policy": <RefundPolicy />,
    "/terms": <LegalPage kind="terms" />,
    "/privacy": <LegalPage kind="privacy" />,
    "/company": <CompanyPage />,
    "/dpa": <LegalPage kind="dpa" />,
    "/compare": (
      <SiteShell>
        <SectionPage section="compare" copy={COMPARE} />
      </SiteShell>
    ),
    "/stories": (
      <SiteShell>
        <SectionPage section="stories" copy={STORIES} />
      </SiteShell>
    ),
    "/guides": (
      <SiteShell>
        <SectionPage section="guides" copy={GUIDES} />
      </SiteShell>
    ),
    "/changelog": (
      <SiteShell>
        <SectionPage section="changelog" copy={CHANGELOG} />
      </SiteShell>
    ),
    "/brand": (
      <SiteShell>
        <Brand />
      </SiteShell>
    ),
  };
  // Pricing is a primary conversion + SEO destination, so it outranks the content-section indexes.
  const priority: Partial<Record<keyof typeof PAGE_SEO, number>> = { "/pricing": 0.9 };

  return (Object.keys(PAGE_SEO) as (keyof typeof PAGE_SEO)[]).map((urlPath) => {
    const seo = PAGE_SEO[urlPath];
    return {
      outFile: `${urlPath.replace(/^\//, "")}/index.html`,
      urlPath,
      html: renderToStaticMarkup(body[urlPath]),
      title: seo.title,
      description: seo.description,
    priority: priority[urlPath] ?? 0.6,
      headExtra:
        hreflangLinks(ORIGIN, urlPath) +
        "\n" +
        renderJsonLd(
        breadcrumbLd(ORIGIN, [
          [BRAND.name, "/"],
          [seo.name, urlPath],
        ]),
      ),
    };
  });
}

/** Build the full set of pages to prerender (home + pricing + marketing sections + blog index + posts). */
export function prerenderPages(): PrerenderPage[] {
  const pages: PrerenderPage[] = [];

  const posts = listPostMeta();

  // The marketing homepage. Its head meta already lives in index.html, so we only inject the body — plus
  // the Organization + WebSite JSON-LD (#294) and the SoftwareApplication node (#467) so crawlers understand
  // ipop as the SaaS product it is (a marketing BusinessApplication), not just an org behind a website.
  pages.push({
    outFile: "index.html",
    urlPath: "/",
    html: renderToStaticMarkup(<Landing />),
    lastmod: posts[0]?.date,
    priority: 1.0,
    headExtra:
      hreflangLinks(ORIGIN, "/") +
      "\n" +
      renderJsonLd([organizationLd(ORIGIN), websiteLd(ORIGIN), softwareApplicationLd(ORIGIN)]),
  });

  // The pricing page + the five content-site sections (#467) — each with its own front-loaded head meta.
  pages.push(...marketingPages());

  // The blog index: Blog node (lists every post) + a Home › Blog breadcrumb.
  pages.push({
    outFile: "blog/index.html",
    urlPath: "/blog",
    html: renderToStaticMarkup(<BlogIndex />),
    title: `${BLOG.title} — ${BRAND.name}`,
    description: BLOG.sub,
    lastmod: posts[0]?.date,
    priority: 0.8,
    headExtra:
      hreflangLinks(ORIGIN, "/blog") +
      "\n" +
      renderJsonLd([
      blogLd(ORIGIN, posts),
      breadcrumbLd(ORIGIN, [
        [BRAND.name, "/"],
        [BLOG.title, "/blog"],
      ]),
    ]),
  });

  // Each published post: BlogPosting + a Home › Blog › Post breadcrumb, og:type=article, and article meta.
  for (const post of posts) {
    pages.push({
      outFile: `blog/${post.slug}/index.html`,
      urlPath: `/blog/${post.slug}`,
      html: renderToStaticMarkup(<BlogPostPage slug={post.slug} />),
      title: `${post.title} — ${BRAND.name}`,
      description: post.description,
      lastmod: post.date,
      priority: 0.7,
      ogType: "article",
      headExtra:
        hreflangLinks(ORIGIN, `/blog/${post.slug}`) +
        "\n" +
        renderJsonLd([
          blogPostingLd(ORIGIN, post),
          breadcrumbLd(ORIGIN, [
            [BRAND.name, "/"],
            [BLOG.title, "/blog"],
            [post.title, `/blog/${post.slug}`],
          ]),
        ]) +
        "\n" +
        articleMeta(post),
    });
  }

  return pages;
}
