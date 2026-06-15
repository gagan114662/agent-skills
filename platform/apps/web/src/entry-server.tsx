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
import { listPostMeta } from "./blog/posts.js";
import type { PrerenderPage } from "./blog/seo.js";

// Re-export the pure SEO helpers so the prerender build script (scripts/prerender.mjs) can import
// everything it needs from this one built SSR bundle.
export { resolveOrigin, injectPage, buildSitemap, buildRobots } from "./blog/seo.js";
export type { PrerenderPage } from "./blog/seo.js";

/** Build the full set of pages to prerender (home + blog index + every published post). */
export function prerenderPages(): PrerenderPage[] {
  const pages: PrerenderPage[] = [];

  // The marketing homepage. Its head meta already lives in index.html, so we only inject the body.
  pages.push({
    outFile: "index.html",
    urlPath: "/",
    html: renderToStaticMarkup(<Landing />),
    priority: 1.0,
  });

  const posts = listPostMeta();

  // The blog index.
  pages.push({
    outFile: "blog/index.html",
    urlPath: "/blog",
    html: renderToStaticMarkup(<BlogIndex />),
    title: `${BLOG.title} — ${BRAND.name}`,
    description: BLOG.sub,
    lastmod: posts[0]?.date,
    priority: 0.8,
  });

  // Each published post.
  for (const post of posts) {
    pages.push({
      outFile: `blog/${post.slug}/index.html`,
      urlPath: `/blog/${post.slug}`,
      html: renderToStaticMarkup(<BlogPostPage slug={post.slug} />),
      title: `${post.title} — ${BRAND.name}`,
      description: post.description,
      lastmod: post.date,
      priority: 0.7,
    });
  }

  return pages;
}
