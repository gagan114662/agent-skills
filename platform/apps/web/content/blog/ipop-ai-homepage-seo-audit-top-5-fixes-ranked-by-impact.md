---
title: "ipop.ai homepage SEO audit — top 5 fixes, ranked by impact"
slug: ipop-ai-homepage-seo-audit-top-5-fixes-ranked-by-impact
description: "Heads up: I could pull the rendered page, robots.txt, and the crawl summary, but the raw‑HTML fetch (curl) got held for approval — so a couple of head‑tag findi"
date: 2026-06-21
status: published
---

Heads up: I could pull the rendered page, robots.txt, and the crawl summary, but the raw‑HTML fetch (`curl`) got held for approval — so a couple of head‑tag findings below are inferred from the crawl rather than eyeballed in source. Flagged where that's the case. Approve the fetch and I'll confirm them against the actual `<head>`.

Here's the draft for review.

---

## 🔍 ipop.ai homepage SEO audit — top 5 fixes, ranked by impact

**What we looked at:** the static markup a crawler/unfurler reads on `/` (plus `/login`, `/start`, `/pricing` for comparison), the live rendered page, and `robots.txt`. **No changes made — findings only.**

First, the good news so we don't bury it: `robots.txt` is clean (`User-agent: * / Allow: /`) and it points to `https://ipop.ai/sitemap.xml`. Nice. Now the fixes.

### 1. There's a developer comment leaking into the `<title>` 🚨
What a crawler reads as our title on the homepage:

> `from VITE_BRAND_TITLE at runtime for the app shell; these tags are what link unfurlers read. --> ipop — your marketing agency of AI agents`

That `-->` is the tail of an HTML comment bleeding into the most heavily‑weighted on‑page element — the thing Google prints in the SERP and Slack/iMessage/LinkedIn print when someone shares us. The real title (`ipop — your marketing agency of AI agents`) is hiding behind build‑template scaffolding. **Highest impact because it's the most visible, most weighted text we own, and right now it reads like a leaked dev note.** Fix: strip the comment from the head template so the title is just the title.

### 2. Every route ships the *identical* title + meta description
`/`, `/login`, `/start`, and `/pricing` all serve the exact same title and the same description ("Hire a whole marketing department of AI agents…"). Classic single‑page‑app symptom: one hardcoded set of tags for the whole site. So `/pricing` can't rank for pricing intent, `/start` can't rank for "get started," and the pages compete with each other for the same snippet. Fix: a unique, intent‑matched title + description **per indexable route** — and lead the homepage one with the category, not just the brand (e.g. "autonomous AI marketing agents," not brand‑first only).

### 3. The page is a Vite app shell — content depends on JavaScript
The "VITE_BRAND_TITLE at runtime" note and the app‑shell framing tell us the H1 and body copy render client‑side. Google *can* render JS, but it's slower, flakier, and most link unfurlers and secondary crawlers **don't** run it at all — they see an near‑empty shell. (Receipt: the static crawl reports the H1 as "The marketing agency of AI agents — you steer, they ship," while the rendered page surfaces different hero copy — a sign the static HTML and the rendered DOM aren't the same thing.) Fix: prerender/SSR the marketing pages so the H1 and key copy exist in the HTML, not just after hydration.

### 4. No social card — shares unfurl as a bare link
*(Inferred from the crawl — the only head tags captured were title + description; needs raw‑`<head>` confirmation.)* No Open Graph image or Twitter Card means a link to ipop.ai in Slack/LinkedIn/X likely shows a plain blue link instead of a branded card. For a product whose whole pitch is "look what the agents shipped," that's free real estate left on the table. Fix: add `og:title`, `og:description`, `og:image` (a real 1200×630 card) and `twitter:card`.

### 5. No structured data — and we're sitting on an easy win
*(Also needs raw‑`<head>` confirmation.)* No JSON‑LD spotted. Two quick, high‑value schemas: **Organization** (logo, name, sameAs) for brand/knowledge‑panel signals, and **FAQPage** — the homepage already has a "Questions, answered straight" section, which is a ready‑made FAQ block that can earn expanded SERP results. Fix: mark up the existing Q&A and add Organization schema.

---

**Ranking logic:** #1–#3 affect whether we show up *correctly at all* (title pollution → duplicate targeting → render risk). #4–#5 are upside plays once the fou

[Built with ipop](https://ipop.ai/?utm_source=ipop&utm_medium=badge&utm_campaign=builtwith&ref=ipop_3af5ccc6fc396ef0)