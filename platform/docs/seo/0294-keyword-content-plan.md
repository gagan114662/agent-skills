# 0294 — Keyword & content plan: rank ipop.ai page 1 for AI-marketing-agency terms

**Issue:** #294
**Author:** Scout (SEO) + Quill (content)
**Date:** 2026-06-16
**Status:** targets configured; the pillar + two spoke articles are published via the content allowlist (#903).

## Goal

Rank ipop.ai on page 1 for five high-intent terms:

1. AI marketing agency
2. AI agent marketing team
3. autonomous marketing agents
4. AI marketing department
5. AI marketing agents for startups

These are the terms a founder types when they've decided they want marketing done *for* them by AI and
are choosing a vendor. They are commercial/transactional, not idle curiosity — exactly our buyer.

> **A note on numbers.** This plan deliberately does **not** invent search volumes. Difficulty is a
> qualitative read (low/med/high) based on SERP competitiveness and term breadth. Anything resembling a
> metric is labelled **UNVERIFIED** and should be checked in a real keyword tool (Ahrefs/Semrush/GSC)
> before being treated as fact.

---

## 1. Keyword map

### Primary terms (the targets in #294)

| Keyword | Intent | Difficulty (UNVERIFIED) | Target page |
| --- | --- | --- | --- |
| AI marketing agency | commercial | high | **Pillar:** `/blog/what-is-an-ai-marketing-agency` + homepage |
| AI marketing department | commercial | med | Pillar (secondary H2) + homepage |
| autonomous marketing agents | commercial | med | Spoke: `/blog/autonomous-marketing-agents-explained` |
| AI marketing agents for startups | commercial | med | Spoke: `/blog/ai-marketing-team-for-startups` |
| AI agent marketing team | commercial | low-med | Spoke: `/blog/ai-marketing-team-for-startups` |

### Supporting / long-tail keywords (~15)

| Keyword | Intent | Difficulty (UNVERIFIED) | Target page |
| --- | --- | --- | --- |
| what is an AI marketing agency | informational→commercial | med | Pillar (`what-is-an-ai-marketing-agency`) |
| AI marketing agency vs traditional agency | commercial | low-med | Existing: `/blog/ai-marketing-agency-vs-hiring-an-agency` |
| AI marketing agency pricing | transactional | low-med | Pillar (pricing H2) → `/pricing` |
| how much does an AI marketing agency cost | commercial | low | Pillar (pricing H2) |
| best AI marketing agency for startups | commercial | med | Spoke: `ai-marketing-team-for-startups` |
| AI marketing agent | informational | med | Spoke: `autonomous-marketing-agents-explained` |
| autonomous AI marketing | informational | low | Spoke: `autonomous-marketing-agents-explained` |
| AI SEO agent | informational | low | Future spoke (Scout angle) |
| AI content marketing agent | informational | low | Future spoke (Quill angle) |
| AI marketing automation vs AI agents | informational | low | Spoke: `autonomous-marketing-agents-explained` |
| marketing without hiring a team | informational | low | Existing: `/blog/how-to-do-marketing-without-hiring-a-team` |
| do AI marketing agents work | informational | low | Spoke: `autonomous-marketing-agents-explained` (FAQ) |
| AI marketing team for early-stage startups | commercial | low | Spoke: `ai-marketing-team-for-startups` |
| replace marketing agency with AI | commercial | low-med | Existing: `ai-marketing-agency-vs-hiring-an-agency` |
| how to brief an AI marketing agent | informational | low | Existing: `/blog/how-to-brief-an-ai-agent-to-write-like-you` |
| why is my site not showing on Google | informational | low | Existing: `/blog/why-client-rendered-sites-are-invisible-to-google` |

---

## 2. Hub-and-spoke content cluster

```
                         ┌────────────────────────────────────────────┐
                         │  PILLAR                                      │
                         │  what-is-an-ai-marketing-agency              │
                         │  target: "AI marketing agency"              │
                         └───────────────┬────────────────────────────┘
            ┌────────────────┬───────────┼───────────────┬────────────────────┐
            │                │           │               │                    │
   autonomous-marketing  ai-marketing-  ai-marketing-   marketing-without-   ai-marketing-agency-
   -agents-explained     team-for-      agency-vs-      hiring-a-team        vs-hiring-an-agency
   (new spoke)           startups       hiring-an-      (existing spoke)     (existing spoke)
                         (new spoke)    agency
```

**Rule:** every spoke links **up** to the pillar with anchor text near "AI marketing agency", and the
pillar links **down** to each spoke. Spokes cross-link to one or two sibling spokes where genuinely
relevant — no link-for-link's-sake stuffing.

### Pillar

- **Title:** What is an AI marketing agency? (a plain-English guide for founders)
- **Slug:** `what-is-an-ai-marketing-agency`
- **Target keyword:** AI marketing agency
- **Intent:** informational → commercial
- **Angle:** define the category honestly, show what the agents actually do, and answer the buying
  questions (cost, control, when it fits) so this page can rank *and* convert.
- **Internal links:** `ai-marketing-agency-vs-hiring-an-agency`, `how-to-do-marketing-without-hiring-a-team`,
  `autonomous-marketing-agents-explained` (new), `ai-marketing-team-for-startups` (new),
  `why-client-rendered-sites-are-invisible-to-google`.

### Spoke 1 (new)

- **Title:** Autonomous marketing agents, explained (and where the "autonomous" part stops)
- **Slug:** `autonomous-marketing-agents-explained`
- **Target keyword:** autonomous marketing agents
- **Intent:** informational
- **Angle:** demystify "autonomous" — what runs on its own vs. what waits for a human gate — and why
  bounded autonomy is the only version safe to point at a live brand.
- **Internal links (up):** pillar `what-is-an-ai-marketing-agency`. **(side):**
  `ai-marketing-agency-vs-hiring-an-agency`, `how-to-brief-an-ai-agent-to-write-like-you`.

### Spoke 2 (new)

- **Title:** An AI marketing team for startups: what you actually get for $49–$499/mo
- **Slug:** `ai-marketing-team-for-startups`
- **Target keyword:** AI marketing agents for startups / AI agent marketing team
- **Intent:** commercial
- **Angle:** the founder's-budget pitch — a seven-agent department, what each does, and how to start
  with one channel instead of a hire.
- **Internal links (up):** pillar `what-is-an-ai-marketing-agency`. **(side):**
  `how-to-do-marketing-without-hiring-a-team`, `autonomous-marketing-agents-explained`.

### Existing spokes (already published — wire the pillar to them)

- `ai-marketing-agency-vs-hiring-an-agency` — comparison/decision spoke.
- `how-to-do-marketing-without-hiring-a-team` — adjacent-need spoke.
- `how-to-brief-an-ai-agent-to-write-like-you` — how-to spoke (links from Spoke 1).
- `why-client-rendered-sites-are-invisible-to-google` — technical-SEO spoke (links from pillar).
- `welcome-to-the-ipop-blog` — not part of the cluster (announcement); no links needed.

---

## 3. Per-article spec (working title · target · intent · angle · internal links)

| Article | Target keyword | Intent | One-line angle | Internal links to existing posts |
| --- | --- | --- | --- | --- |
| What is an AI marketing agency? (pillar) | AI marketing agency | info→commercial | Define the category honestly and answer the buying questions in one page | `ai-marketing-agency-vs-hiring-an-agency`, `how-to-do-marketing-without-hiring-a-team`, `why-client-rendered-sites-are-invisible-to-google` |
| Autonomous marketing agents, explained | autonomous marketing agents | informational | Show exactly where "autonomous" stops and the human gate begins | `ai-marketing-agency-vs-hiring-an-agency`, `how-to-brief-an-ai-agent-to-write-like-you` |
| AI marketing team for startups | AI marketing agents for startups | commercial | A seven-agent department at a founder's budget; start with one channel | `how-to-do-marketing-without-hiring-a-team`, `how-to-brief-an-ai-agent-to-write-like-you` |

---

## 4. Backlink & distribution plan (white-hat only)

No PBNs, no paid link networks, no link exchanges, no exact-match anchor spam. Earn links by being
worth citing.

**Digital PR / data angles**
- Publish a small original-data piece (e.g. "what an AI marketing department actually shipped in 30 days"
  using anonymized ipop run data) — original data is the most linkable asset we can make. Label every
  number truthfully; UNVERIFIED until measured.
- A founder-economics teardown ("agency retainer vs. AI department: a real cost breakdown") pitched to
  startup/marketing newsletters.

**Founder communities (participate, don't spam)**
- Indie Hackers, r/startups, r/SaaS, r/marketing, MicroConf / SaaS Slack and Discord groups,
  Hacker News (Show HN when there's a genuinely new thing to show). Answer questions, link only when the
  article truly answers the question asked.

**Comparison / listicle placements**
- Get ipop into "best AI marketing tools / agencies for startups" roundups. Reach out to the authors with
  a tight, factual one-paragraph description and a screenshot. Offer a founder quote, not a fee.

**Guest posts**
- Pitch genuinely useful guest articles (e.g. "the human-approval gate that makes AI marketing safe") to
  startup and marketing blogs that accept contributors. One real byline > ten thin posts.

**HARO-style / expert sourcing**
- Respond to journalist requests (Connectively/HARO successors, Qwoted, Help a B2B Writer) on AI-in-
  marketing topics with concise, quotable, non-promotional answers.

**Product directories**
- List on relevant directories: Product Hunt launch, G2/Capterra (AI marketing category), There's An AI
  For That, Futurepedia, BetaList, AlternativeTo. These are legitimate citations and discovery surfaces.

**Internal linking (the cheapest "backlinks" we control)**
- Wire the cluster per §2, and add a contextual link to the pillar from the homepage and `/pricing`.

---

## 5. On-page checklist (apply to every article)

- [ ] **Title tag ≤ 60 chars** — front-load the target keyword. (Rendered from `title`; if `title` runs
      long, the page heading can stay descriptive but keep the indexable title tight.)
- [ ] **Meta description ≤ 155 chars** — the `description` frontmatter field; one sentence, benefit + keyword,
      reads like ad copy.
- [ ] **Single H1** — the article body opens with one `# Title` (matches existing posts; the renderer emits
      it as the only level-1 heading). No second H1 anywhere.
- [ ] **H2 structure** — logical sections, target keyword in at least one H2 naturally (never stuffed).
- [ ] **Internal links** — 2–4 contextual links to existing posts using `/blog/<slug>` markdown links;
      spokes link up to the pillar.
- [ ] **Keyword placement** — primary keyword in the first 100 words, the H1, and the description; variants
      in H2s and body. Write for the reader first; if it reads stuffed, cut it.
- [ ] **FAQ schema candidates** — each article ends with a short FAQ (Q as `## …` or bolded Q + answer)
      so we can add `FAQPage` structured data when we wire schema. Candidate questions per article:
  - Pillar: "What is an AI marketing agency?", "How much does an AI marketing agency cost?",
    "Is an AI marketing agency safe to use?"
  - Autonomous spoke: "Are autonomous marketing agents fully automatic?", "Do AI marketing agents
    actually work?", "What's the difference between marketing automation and AI agents?"
  - Startups spoke: "What does an AI marketing team for startups cost?", "Can AI replace a marketing
    hire?", "Where should a startup start with AI marketing?"
- [ ] **Voice** — plain, confident, founder-to-founder; lowercase "ipop"; no hype, no fabricated stats.
- [ ] **Length** — pillar ~1,200–1,600 words; spokes ~1,000–1,300 words.
- [ ] **Status gate** — `status: draft` until the owner approves and flips to `published` (the blog loader
      ignores drafts; this is the #200 §4 irreversible-public-content gate).

---

## 6. Sequencing

1. Land the three drafts (this issue) — pillar + 2 spokes — alongside the existing spokes.
2. Owner reviews, edits voice/claims, flips `status: draft → published` per piece.
3. Wire homepage + `/pricing` contextual links to the pillar.
4. Submit updated sitemap in Google Search Console; track the five primary terms.
5. Begin distribution (§4): directories first (fast), then digital-PR/data piece, then guest posts.
6. Add `FAQPage` schema to the articles (separate code change; out of scope for this content-only issue).
