Pulled the homepage, robots, sitemap, and a couple of routes. Receipts gathered — here's the audit.

---

## 🔍 Homepage SEO audit — ipop.ai

Good news first: `robots.txt` is clean and permissive, and the `sitemap.xml` is healthy (8 URLs, fresh `lastmod` dates, homepage at priority 1.0, blog included). So crawlers can get in and find things. The problems are all in *what they find when they land*.

Top 5 fixes, ranked by impact:

**1. There's a developer comment leaking into the title tag.** This is the big one. What unfurlers and Google actually read as our title:

> `from VITE_BRAND_TITLE at runtime for the app shell; these tags are what link unfurlers read. --> ipop — your marketing agency of AI agents`

That `-->` is a stray HTML comment that got concatenated into the `<title>`. Every link preview — Slack, iMessage, LinkedIn, the SERP — is showing a code note before our brand name. Highest impact, lowest effort. Strip the comment, ship a clean title.

**2. We're a client-rendered SPA, and the title is injected "at runtime."** The comment itself tells the story — the real title comes from `VITE_BRAND_TITLE` *after* JS runs. That means the static HTML a crawler first sees has the placeholder/fallback, not the real thing. We literally have a blog post titled *"why client-rendered sites are invisible to Google"* — let's not be the cautionary tale. Recommend pre-rendering or SSR for the meta + hero content so it's in the initial HTML, not painted on after.

**3. Every route shares one identical title + description.** `/`, `/login`, `/start`, and `/pricing` all return the same `ipop — your marketing agency of AI agents` title and the same description. `/pricing` isn't even resolving as its own indexable page with its own metadata — it's an anchor on the SPA. No per-page targeting means pricing-intent and brand-intent searches all compete for one generic snippet. Give each real page a unique title/description.

**4. No canonical, no Open Graph, no Twitter card tags.** I found no `rel=canonical`, no `og:` tags, no `twitter:` tags in the head. That means (a) no control over how we look when shared — no preview image, no curated title/desc — and (b) duplicate-URL dedup risk (`/`, `/start`, `/login` all serving the same content). Add a self-referencing canonical and a full OG/Twitter set with an image.

**5. The title leads with brand, and the H1 doesn't match it.** Our title front-loads `ipop` instead of the thing people search for ("AI marketing agency"). Separately, the rendered H1 reads *"Your always-on marketing department"* while the hero/meta say *"The marketing agency of AI agents."* Pick one primary message, lead the title with the keyword, and make the H1 echo it. Lowest of the five, but it's the cheap on-page polish once 1–4 are done.

---

Two caveats worth flagging before anyone acts: when I fetched with a JS-rendering bot the body content *did* appear, but the link-unfurl crawl only got the polluted meta — so #2 is a "verify against raw `view-source`" item, not a settled fact. And I'd confirm #4 against the true source HTML too, since rendered-head injection can hide tags from a quick look.

Want me to draft the corrected title/description/OG set for each route next, or dig into the raw `view-source` to nail down the SSR question first?

[Built with ipop](https://ipop.ai/?utm_source=ipop&utm_medium=badge&utm_campaign=builtwith&ref=ipop_ff44d2462cc7abfe)