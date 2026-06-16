# ipop.ai technical SEO audit (#294)

**Method:** live `curl` of the production deployment (Vercel) on **2026-06-16**, raw HTML inspected (not a
markdown-converted view, so `<head>` tags and JSON-LD are seen exactly as crawlers receive them). This is a
production-grounded audit (premortem #200 §3), not a self-report.

## Summary

The #252 prerender pipeline is **working** — the homepage and blog serve real prerendered HTML, so the site
is crawlable (this was the previous existential risk and it is resolved). The remaining gaps are
structured-data, social-image format, and a few crawl/snippet hints — plus there was no rank measurement at
all. This PR fixes the on-site items it can fix in code and wires external rank tracking.

## What is already correct (evidence)

| Check | Result |
| --- | --- |
| Homepage HTTP | `200`, `content-type: text/html`, `server: Vercel`, 33 KB prerendered body |
| `<html lang>` | `en` ✓ |
| `<title>` | present (home + per-post) ✓ |
| meta description | present (home + per-post) ✓ |
| canonical | present + correct per URL (`https://ipop.ai/`, `/blog/<slug>`) ✓ |
| Open Graph / Twitter | full set present ✓ |
| `robots.txt` | `200`, `Allow: /`, `Sitemap: https://ipop.ai/sitemap.xml` ✓ |
| `sitemap.xml` | `200`, home + `/blog` + 5 posts with lastmod/priority ✓ |
| blog posts | render with real article text + per-post title/description/canonical ✓ |

## Defects found

### 1. No JSON-LD structured data (HIGH) — FIXED in this PR
`grep 'application/ld+json'` returned **0** on the homepage, `/blog`, and every post. Search engines had to
infer the ipop entity, the blog, and each article from prose. No Organization, WebSite, Blog, BlogPosting,
or BreadcrumbList.
**Fix:** `apps/web/src/blog/structured-data.ts` + prerender injection — Organization+WebSite on home,
Blog+BreadcrumbList on `/blog`, BlogPosting+BreadcrumbList on each post. Verified present in the built
`dist/` output and valid-JSON parseable.

### 2. og:image / twitter:image are SVG (HIGH) — DOCUMENTED follow-up
`og:image = https://ipop.ai/og.svg`, served `content-type: image/svg+xml`. Facebook, LinkedIn, X/Twitter,
and Slack do **not** render SVG link previews, so social unfurls are broken. No `og:image:alt`.
**Partial fix in PR:** added `og:image:alt`, `og:image:type`, `twitter:image:alt`. **Full fix is a
follow-up:** a 1200×630 PNG at `/og.png` (a binary asset, out of scope for this change — not faked by
pointing at a non-existent file).

### 3. Missing crawl / snippet hints (MEDIUM) — FIXED in this PR
- No `robots` meta → added `index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1`.
- Blog posts used `og:type=website` → now `article`, with `article:published_time` + `article:author`.
- `og:title` ("…the marketing agency…") differed from `<title>` ("…your marketing agency…") → aligned.
- Added `og:locale=en_US`.

### 4. No rank tracking (HIGH) — FIXED in this PR
The founder-console SEO proof tile was hard-coded `connected:false`, and there was no store for a ranking.
**Fix:** `seo_rank_observations` external-receipt table + `POST /me/seo/observations` ingest + provider seam
(default dry-run, real providers behind the #192 vault as a follow-up) + the proof tile reads it. Connected
only when a real external observation exists — never a self-reported rank (premortem §2).

## Not assessed (honest scope note)

- **Core Web Vitals** — no Lighthouse / CrUX field-data run was in scope. Structural observations only: the
  homepage loads a single JS module + one CSS file (no obvious render-blocking chains beyond the app bundle),
  prerendered HTML means first paint does not wait on JS. A proper PSI/CrUX pass is a follow-up.
- **Backlink profile** — covered as a plan in `0294-keyword-content-plan.md` (white-hat only), not measured.

## Raw evidence (abridged)

```
$ curl -sS -D - https://ipop.ai/
HTTP/2 200 ; content-type: text/html; charset=utf-8 ; server: Vercel ; content-length: 33766
<html lang="en"> … <title>ipop — your marketing agency of AI agents</title>
<link rel="canonical" href="https://ipop.ai/" />
<meta property="og:image" content="https://ipop.ai/og.svg" />   # SVG → broken unfurls
$ grep -c application/ld+json home.html  →  0                    # no structured data
$ curl -sS https://ipop.ai/robots.txt   →  Allow: / ; Sitemap: https://ipop.ai/sitemap.xml
$ curl -sS https://ipop.ai/sitemap.xml  →  home + /blog + 5 posts
$ curl -I https://ipop.ai/og.svg        →  content-type: image/svg+xml
```
