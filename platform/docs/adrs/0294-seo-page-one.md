# ADR-0294: Technical SEO + externally-grounded rank tracking for ipop.ai

- **Status:** Accepted (shipped in PR for #294)
- **Date:** 2026-06-16
- **Context issue:** [#294](https://github.com/gagan114662/agent-skills/issues/294) — get ipop.ai onto
  page 1 for high-intent terms ("AI marketing agency", "AI agent marketing team", "autonomous marketing
  agents"). Today there is no evidence the site ranks. Scope: a real technical SEO audit of the live site,
  on-site technical fixes, a keyword + content plan with a first draft cluster staged behind approval, and
  a way to track rankings via an EXTERNAL source.
- **Builds on:** [ADR-0252](#) / #252 (the build-time prerender that turned the SPA into indexable static
  HTML — the lever every on-site fix here rides), #256 (sitemap.xml / robots.txt), [ADR-0253](0253-proof-scorecard.md)
  (the founder-console proof scorecard — whose SEO tile was hard-coded "not connected" and is now wired),
  [ADR-0189](0189-acquisition-execution.md) / [ADR-0280](0280-reach-outbound.md) (the external-receipt
  store pattern this copies), [ADR-0035](0035-config-layering.md) (layered default-OFF feature config),
  [ADR-0200](0200-premortem-panel.md) (the standing premortem this answers to).

## Context

A live audit of ipop.ai on 2026-06-16 (raw `curl` of the production Vercel deployment, evidence in
`docs/seo/0294-technical-audit.md`) found the prerender pipeline (#252) working — the homepage and blog
serve real prerendered HTML with a clean `<head>` (title, meta description, canonical, Open Graph,
Twitter), `robots.txt`, and a `sitemap.xml`. But three concrete technical defects remained, and there was
no rank measurement at all:

1. **No JSON-LD structured data** on any page — search engines had to infer the ipop entity, the blog, and
   each article from prose. No Organization, WebSite, Blog, BlogPosting, or BreadcrumbList.
2. **`og:image` / `twitter:image` are SVG** (`image/svg+xml`), which Facebook / LinkedIn / X / Slack do not
   render — social unfurls are broken. No `og:image:alt`.
3. **Missing crawl/snippet hints**: no `robots` meta (`max-image-preview:large`), blog posts used
   `og:type=website` instead of `article`, no `article:*` meta.
4. **No rank tracking** — the SEO proof tile was hard-coded `connected:false`, and there was no store for a
   ranking even if one were known.

## Decision

### On-site technical SEO (apps/web, prerender path — no new runtime)

There is no client-side head manager; the only lever is the static `index.html` shell + the build-time
prerender (`entry-server.tsx` → `injectPage`). So:

- A new pure module `apps/web/src/blog/structured-data.ts` builds the schema.org graph: **Organization +
  WebSite** (home), **Blog + BreadcrumbList** (index), **BlogPosting + BreadcrumbList** (each post).
  `renderJsonLd` unicode-escapes `<`/`>`/`&` so a value can never break out of the `<script>` element
  (the standard XSS-safe JSON-LD embedding — defence in depth even though every value is our own copy).
- `injectPage` gained `ogType` (per-page `og:type`) and `headExtra` (markup injected before `</head>`) so
  the prerender drops the JSON-LD + `article:*` meta into the static head. Posts now emit `og:type=article`
  + `article:published_time` / `article:author`.
- `index.html` gained a `robots` meta (`max-image-preview:large, max-snippet:-1, max-video-preview:-1`),
  `og:locale`, `og:image:alt`/`og:image:type`, `twitter:image:alt`, and `og:title`/`twitter:title` aligned
  with `<title>`.
- **No SearchAction** is declared on WebSite: the marketing site serves no site-search endpoint, and
  claiming one we don't serve would be a structured-data violation.

**Deferred (documented, not faked):** the SVG `og:image` is the top remaining defect. Fixing it needs a
1200×630 raster (`/og.png`); generating a quality binary asset is out of scope for this change, so it is
recorded as a follow-up rather than pointing `og:image` at a file that doesn't exist (which would break
unfurls worse). Core Web Vitals were not benchmarked with field data (no Lighthouse/CrUX run in scope);
the audit notes the structural observations only.

### Content (keyword plan + draft cluster — staged behind the approval gate)

- A keyword + hub-and-spoke content plan + a white-hat backlink/distribution plan live in
  `docs/seo/0294-keyword-content-plan.md`. Estimates are qualitative and labelled UNVERIFIED (premortem §2);
  no fabricated search volumes.
- A first cluster of three articles (pillar `what-is-an-ai-marketing-agency` + two spokes) is drafted as
  `apps/web/content/blog/*.md` with **`status: draft`**. The blog loader (`posts.ts`) only loads
  `status: published`, so drafts are inert — not prerendered, not in the sitemap, invisible — until an
  owner edits the frontmatter and commits. **This is the human gate** for publishing public content
  (premortem §4: public content is irreversible → human, not post-hoc review). Verified live: the build
  prerenders only the 5 published posts, never the 3 drafts.

### Rank tracking (apps/server — external receipts only)

- A new `seo_rank_observations` table (migration `0294`, non-governed name so the #155 colocation gate is
  not tripped) stores one row per `(keyword, url, position)` a **real external source** reported, keyed by
  the provider's own `external_id` (idempotent upsert). `position` is nullable = an honest "not ranking",
  never fabricated. This is the same external-receipt pattern as `acquisition_send_receipts` (#189) and
  `reach_receipts` (#280).
- A provider seam (`RankTrackingProvider`) with a default `DryRunRankProvider` that returns nothing. Real
  providers (Search Console / SerpApi / DataForSEO) need a vault credential and are **not wired here** (no
  credentials in this change); `resolveRankProvider` returns the dry-run provider until one is built. The
  proactive `track()` fetch is config default-OFF.
- Pure `decideRankIngest` sanitises every untrusted provider/webhook row (control-char strip, length clamp,
  closed search-engine enum) and **drops any row without an `external_id`** — without it there is no
  external receipt to trust. The keyword/URL are STRUCTURAL data: stored and displayed, never instructions,
  never a trigger for a send or spend (premortem §6).
- Ingest path: `POST /me/seo/observations` accepts external receipts (a rank-API webhook / GSC export /
  owner paste) regardless of the enabled flag — recording proof someone else produced is not a fetch or a
  spend. `dryrun` is rejected as a source on this route.
- The founder-console SEO proof tile now reads these rows: `connected` iff ≥1 external observation exists,
  headline = target keywords on page 1 (positions 1–10) as of each keyword's latest reading; otherwise it
  stays "not connected" with the reason — so it can only ever show an externally-grounded number
  (premortem §2/§3).

## How this answers the premortem (#200)

- **§2 self-reported metrics are fiction** — the rank tile reads `seo_rank_observations` and nothing else;
  with no connected source it shows "not connected", never a made-up rank. Plan estimates are UNVERIFIED.
- **§3 verification touches reality** — the audit was run against the live production deployment; the
  prerender output and migration up/down were verified, not assumed.
- **§4 reversibility / irreversible public actions** — publishing content is gated by `status: draft` (a
  human flips it), not autonomous.
- **§6 injection defence** — a provider/webhook response is untrusted DATA; `decideRankIngest` sanitises it
  and it can never become an instruction or a write trigger.

## Consequences

- The site now ships an explicit entity graph; rich-result and entity understanding no longer depend on
  prose inference. Social unfurls remain degraded until the raster `og:image` follow-up.
- Rankings can be tracked the moment an owner connects a real source or POSTs receipts — the table, route,
  and tile are live and default-OFF / dry-run, so nothing changes for an un-configured workspace.
- Follow-ups: a live Search Console / SERP provider behind the #192 vault; a 1200×630 PNG `og:image`; a
  Lighthouse/CrUX Core Web Vitals pass; owner promotes the draft cluster after review.
