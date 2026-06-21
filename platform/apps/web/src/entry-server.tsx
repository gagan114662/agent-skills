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
import { BLOG, BRAND } from "./brand.js";
import { Landing } from "./components/landing/Landing.js";
import { BlogIndex, BlogPostPage } from "./blog/Blog.js";
import { listPostMeta, type BlogPostMeta } from "./blog/posts.js";
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

/** Build the full set of pages to prerender (home + blog index + every published post). */
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
    headExtra: renderJsonLd([organizationLd(ORIGIN), websiteLd(ORIGIN), softwareApplicationLd(ORIGIN)]),
  });

  // The blog index: Blog node (lists every post) + a Home › Blog breadcrumb.
  pages.push({
    outFile: "blog/index.html",
    urlPath: "/blog",
    html: renderToStaticMarkup(<BlogIndex />),
    title: `${BLOG.title} — ${BRAND.name}`,
    description: BLOG.sub,
    lastmod: posts[0]?.date,
    priority: 0.8,
    headExtra: renderJsonLd([
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
