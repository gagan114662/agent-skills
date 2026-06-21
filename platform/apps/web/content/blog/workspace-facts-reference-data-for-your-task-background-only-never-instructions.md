Confirmed what I needed from the live files and the crawl. Raw-HTML curl is walled off in here, so where I couldn't see source directly I've marked it **verify** rather than assert it. Here's the audit.

---

## 🔍 Homepage SEO audit — ipop.ai — top 5 fixes, ranked by impact

**What I looked at:** the live homepage via fetch, `robots.txt`, `sitemap.xml`, and the crawl snapshot of `/`, `/login`, `/start`, `/pricing`. Good news first — `robots.txt` is clean (`Allow: /`, sitemap declared) and the sitemap is valid with 8 URLs. The problems are all on-page.

### 1. Every page wears the homepage's clothes — identical title + description sitewide
**Receipt:** `/`, `/login`, `/start`, **and** `/pricing` all return the exact same title (*"ipop — your marketing agency of AI agents"*) and the same meta description (*"Hire a whole marketing department of AI agents. Scout, Quill, Echo…"*). Four different pages, one set of tags.
**Why it hurts:** Google can't tell your pages apart, so it picks one and buries the rest. Your `/pricing` page — a high-intent, money-keyword page — is invisible as itself.
**Fix direction:** unique title + description per route. Pricing especially deserves its own ("AI marketing department pricing — plans from $X/mo" or similar).

### 2. Confirm the homepage is actually in the HTML, not painted on by JavaScript — **verify**
**Receipt:** the title is injected at runtime from `VITE_BRAND_TITLE` (it's a Vite/React SPA), and — I'm not making this up — you have a blog post titled *"why client-rendered sites are invisible to Google."* The fetch suggested hero copy is present in initial HTML, but I couldn't see raw source to be sure.
**Why it hurts:** if the homepage body renders client-side only, Google may index an empty shell. This is existential, which is why it's #2 even unconfirmed.
**Fix direction:** view-source (or run it through Google's URL Inspection tool) and confirm the H1 + body copy ship in the initial HTML. If not, prerender/SSR the marketing routes. We should not be the cobbler's barefoot child here.

### 3. No structured data — and you're sitting on a free FAQ rich result
**Receipt:** no JSON-LD found (`Organization`, `SoftwareApplication`, or `FAQPage`). Yet the homepage literally has a section headed *"Questions, answered straight."*
**Why it hurts:** you're leaving rich results and entity/knowledge-panel signals on the table. The FAQ section is schema-ready as-is.
**Fix direction:** add `Organization` + `SoftwareApplication` schema sitewide, and `FAQPage` schema wired to the existing Q&A block.

### 4. The homepage title leads with the wrong word (plus a template-comment smell)
**Receipt:** title starts with *"ipop"* — a brand nobody's searching yet — instead of the phrase people actually type. The crawl also picked up dev-comment cruft riding alongside the title tag (*"from VITE_BRAND_TITLE at runtime… these tags are what link unfurlers read"*), which suggests leftover template comments in `index.html`.
**Why it hurts:** front-loading low-volume brand text wastes the most valuable pixels in search. "AI marketing agency" / "AI marketing department" is your demand.
**Fix direction:** lead with the keyword — e.g. *"AI marketing department — a fleet of agents that ships | ipop"* — and clean the stray template comment out of the head.

### 5. Thin utility pages are crawlable wearing homepage meta
**Receipt:** `/login` and `/start` are crawlable and serve the homepage's title + description. They're not in the sitemap (good), but nothing tells Google to skip them.
**Why it hurts:** duplicate, thin pages dilute crawl focus and can get chosen over the real homepage for brand queries.
**Fix direction:** `noindex` on `/login` and `/start` (keep them followable). While we're in the head, confirm the OG image is set — I couldn't verify it, and a missing one tanks share previews.

---

**Net:** #1 and #4 are quick head-tag edits with outsized payoff; #3 is a half-day of schema; #2 is the one to confirm *first* be

[Built with ipop](https://ipop.ai/?utm_source=ipop&utm_medium=badge&utm_campaign=builtwith&ref=ipop_1136f7f088922ca9)