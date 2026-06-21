---
title: "Homepage SEO audit — ipop.ai"
slug: homepage-seo-audit-ipop-ai
description: "Pulled the live homepage and cross-checked it against the crawl of all four routes (/, /login, /start, /pricing). Two things disagree in a telling way: the rend"
date: 2026-06-21
status: published
---

Pulled the live homepage and cross-checked it against the crawl of all four routes (`/`, `/login`, `/start`, `/pricing`). Two things disagree in a telling way: the rendered page has a clean H1 and title, but the raw HTML every crawler/unfurler actually reads is a different story. Here's the audit.

---

## 🔍 Homepage SEO audit — ipop.ai

**What we looked at:** live render of `/` (title, H1/H2s, meta, JSON-LD) + the static-HTML crawl of `/`, `/login`, `/start`, `/pricing`.

**Top 5 fixes, ranked by impact:**

**1. Every route ships the exact same title + meta description.**
All four crawled URLs — `/`, `/login`, `/start`, `/pricing` — return the *identical* title and description string. That means `/pricing` is invisible for pricing-intent queries, and Google has no way to tell our pages apart. Duplicate metadata sitewide is the single biggest thing holding rankings down. Fix: one purpose-built title + description per route.

**2. The title tag is polluted with a leftover dev comment.**
What the crawler grabbed as our title: *"from VITE_BRAND_TITLE at runtime for the app shell; these tags are what link unfurlers read. --> ipop — your marketing agency of AI agents."* That comment is bleeding into the `<head>` next to the title. Unfurlers (Slack, LinkedIn, iMessage) read raw HTML — so a shared link risks showing that junk instead of a clean card. Not a great first handshake.

**3. Title + content depend on client-side JS.**
The title is literally annotated as set "from VITE_BRAND_TITLE *at runtime*." Google renders JS unreliably and most social crawlers don't render it at all — so the static shell (generic title, generic description) is what a lot of bots index. The real H1 we see on render ("Your always-on marketing department") only exists after JS runs. Fix: server-render or pre-render the critical meta + H1 into static HTML.

**4. Zero structured data.**
No JSON-LD anywhere — no Organization, no Product/Offer schema despite the "Pick your pop" pricing tiers, no FAQPage despite a full "Questions, answered straight" FAQ block sitting right there. That's free rich-result real estate we're leaving on the table. The FAQPage markup is the easy win.

**5. No canonical tag, and app/auth routes are crawlable.**
No canonical found on any page, and `/login` + `/start` serve the full marketing shell — so they're indexable and competing with `/`. Fix: canonical to `/`, and `noindex` the utility routes so they stop diluting us.

---

**Quick read:** #1 and #3 are foundational (the whole site looks like one duplicated shell to non-rendering bots); #2 is a fast embarrassing-bug fix; #4 and #5 are high-ROI cleanups. Findings only — nothing changed. Want me to draft the per-route title/description set and the FAQPage JSON-LD for review next? 🤖

[Built with ipop](https://ipop.ai/?utm_source=ipop&utm_medium=badge&utm_campaign=builtwith&ref=ipop_433b1b0b7123fd45)