---
name: seo-technical-audit-checklist
kind: reference
domain: seo
description: Ordered technical SEO audit — crawlability, rendering, architecture, CWV, schema, mobile, HTTPS — with check method, "good" bar, and fix for each.
---

# Technical SEO Audit Checklist

Run in this order. Each item dies on the one above it: a page that can't be crawled can't be rendered, and a page that isn't indexed can't rank no matter how fast it is.

## 1. Crawlability & indexability

- **robots.txt** — Check `https://domain/robots.txt`. Good: it does NOT `Disallow: /` and does not block `/_next/`, `/static/`, `/*.css`, `/*.js`. The classic disaster is a staging `Disallow: /` shipped to prod. Fix: allow assets; only block true crawler traps (faceted `?sort=`, `/cart`, internal search).
- **XML sitemap** — Pull `/sitemap.xml`. Good: only 200-status, canonical, indexable URLs; `<lastmod>` is real; < 50k URLs / 50MB per file; referenced in robots.txt. Fix: strip 3xx/4xx/noindex/non-canonical URLs — Google treats a dirty sitemap as a quality signal.
- **Indexability** — In GSC → Pages, check Indexed vs "Crawled – currently not indexed" / "Discovered – not indexed" (a quality/crawl-budget tell, not a bug). Per page, confirm no `<meta name="robots" content="noindex">` and no `X-Robots-Tag: noindex` header (`curl -I`). Good: money pages are indexed and appear in `site:domain/path`. Fix: remove stray noindex (often a CMS default or a copied template).
- **Canonicals** — Each page declares `<link rel="canonical">`. Good: self-referential on canonical pages; variants (`?utm=`, pagination, http/https, trailing-slash) point to the one true URL; absolute URLs only. Fix: one canonical per page; never canonical everything to the homepage (Google ignores it and you lose the rest).

## 2. Rendering — the SPA "invisible to Google" trap

- **Check**: `curl -s URL | grep "<h1>"` and view raw HTML, OR GSC → URL Inspection → "View crawled page" → HTML. Compare against the DevTools rendered DOM.
- **The trap**: client-side-rendered React/Vue ships `<div id="root"></div>` and nothing else. Googlebot renders JS, but on a deferred second-wave queue (days later, JS errors silently drop content, and `fetch`-on-mount data often never lands).
- **Good**: primary content, `<h1>`, internal links, and meta are present in the *raw* HTML before JS runs.
- **Fix**: SSR or SSG (Next.js `app`/`getStaticProps`, prerender). At minimum, prerender for bots. Internal links must be real `<a href>` — `onClick` router pushes are uncrawlable.

## 3. Site architecture & internal linking

- **Check**: crawl with Screaming Frog; look at crawl depth and inlinks per URL. Good: every money page ≤ 3 clicks from home; ≥ 1 contextual internal link in; no orphans (0 inlinks); descriptive anchor text (not "click here").
- **Fix**: flatten deep trees, add hub/spoke internal links from topic pillars, link new pages from existing high-authority pages on publish.

## 4. Core Web Vitals (field, not lab)

- **Targets (75th percentile, mobile)**: LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1.
- **Check**: GSC → Core Web Vitals (CrUX field data) for the real number; PageSpeed Insights for per-URL field + lab.
- **Usual culprits**: LCP — unoptimized hero image, render-blocking CSS/JS, slow TTFB. INP — heavy JS on the main thread, big hydration. CLS — images without `width`/`height`, injected ads/banners, web fonts (FOIT).
- **Fix**: see `core-web-vitals.md`.

## 5. Structured data / schema

- **Check**: Rich Results Test + GSC Enhancements. Good: valid JSON-LD matching visible content (Article, Product+offers/rating, FAQ, Breadcrumb, Organization). Fix: resolve errors (warnings are optional); never mark up content not on the page — that's a manual-action risk.

## 6. Mobile

- **Check**: mobile-first index means Google ranks the *mobile* DOM. Confirm mobile renders the same content/links as desktop; tap targets ≥ 48px; no horizontal scroll. Fix: never hide primary content behind "load more" that requires JS only desktop fires.

## 7. HTTPS & redirects

- **Check**: `curl -IL http://domain`. Good: single 301 http→https, no chains/loops, HSTS set, valid cert, one canonical host (www vs apex picked and 301'd). Fix: collapse redirect chains to a single hop (each hop bleeds crawl budget and link equity).

made by robots, steered by humans.
