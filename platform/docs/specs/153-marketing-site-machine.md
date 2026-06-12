# Spec: The marketing-site machine — comparisons, stories, changelog, guides, trial funnel (Issue #153)

> Implements [#153](https://github.com/gagan114662/agent-skills/issues/153). Lifecycle: **DEFINE**
> artifact (`spec-driven-development`). Extends **#149** (PR #154 — the public landing at `/`, the
> dependency-free `routing.tsx` seam, `AuthGate` as the phase+route boundary, code-split public
> surfaces). Reuses [#13](../adrs/0013-approval-gates.md) (`external.send` gate, sensitive by
> default), [#123](../adrs/0123-marketing-department-fleet.md) (the draft-only named fleet —
> scout/quill/echo — and the `@mention → venture-gated session` path), [#125](../adrs/0125-pricing-plans.md)
> (the plan catalog + `GET /billing/plans`), and [#138](../adrs/0138-pop-identity-channels-deploy.md) /
> the committed brand book (`docs/brand/ipop-brand-identity.html`).

> **Numbering note.** Spec / ADR use the `0153` / `153` slot (the issue number), per the project's
> by-issue numbering convention (ADR-0099's note). **This PR ships no migration** — it is additive
> read-models + pure modules over existing repos and gates, so there is zero sibling-workspace
> collision surface in the shared Conductor Postgres.

## ⚠️ Decision first — build vs. integrate

**Do not build a CMS.** Back the marketing site with **repo markdown** read at request time (a
"CMS-lite"), serve it over public read-only endpoints, and route every *publish* through the **existing
#13 `external.send` gate** — no new approval action type, no new executor, no core change. Content is
authored by the **existing #123 fleet** (`@quill` drafts, `@scout` researches, `@echo` summarises) via
the @mention path that already ships; #153 adds the **public storefront** those drafts land on and the
**gated publish workflow** in front of it. See [ADR-0153](../adrs/0153-marketing-site-machine.md).

## Objective

**What:** Turn ipop.ai from a single landing page into a *marketing machine the fleet itself maintains*:

1. **`/compare/[alternative]`** — honest, brand-voice, SEO-structured comparison pages: *vs hiring an
   agency*, *vs DIY*, *vs a generic AI chat*. Drafted by `@quill`/`@scout`, publish-gated.
2. **`/stories`** — a CMS-lite section backed by repo markdown. The first story is **ipop's own
   marketing**, the dogfood, with real metrics from the venture loop.
3. **`/changelog`** — auto-drafted weekly from merged-PR titles (`@echo` summarises → owner approves →
   publish). A pure `draftChangelog(prs, weekOf)` turns conventional-commit titles into release notes.
4. **`/guides`** — 2–3 cornerstone SEO pieces (*How AI agents run an SEO audit*, *Marketing automation
   with approval gates*).
5. **Trial funnel** — *Start free* CTA → signup → the preloaded workspace **is** the trial; a soft
   paywall nudge surfaces when a cap is hit, wired to the #125 pricing surface.
6. **Ask-AI deep links** — footer links that pre-fill *"explain ipop to me"* into ChatGPT / Claude /
   Perplexity (the GEO play).
7. **`/brand`** — an assets page serving the pop marks, wordmark, and palette from `docs/brand`.

**The twist:** every content surface is **footed "maintained by quill, our content agent"**, every
publish is **#13-gated**, and content generation **routes through the marketing task path** (the #123
fleet) so the product demonstrates itself.

**Why:** Both reference marketing machines (ona.com, incident.io) run comparison pages, customer
stories, an auto-drafted changelog, cornerstone guides, and a self-serve trial. ipop had a landing page
and nothing behind it. This is second-wave gap coverage — and the most honest possible demo of the
product, because the marketing site is *built and maintained by the agents it sells*.

## Non-goals

- **No CMS / admin UI / WYSIWYG.** Content is committed markdown; editing is a PR.
- **No new migration, no new approval action type, no executor change.** Publish reuses
  `external.send` through the existing `POST /workspaces/:wid/actions` path verbatim.
- **No runtime repo writes.** "Publish" is the #13 gate clearing in front of a human committing the
  markdown — the same way every other artifact in this repo becomes real.
- **No scheduler wiring.** "Weekly" is an operational cron (a GitHub Action calling the drafter),
  consistent with #99/#108 uptime/DR drills. This PR ships the pure drafter + a seeded first entry.

## Surface

### Content store (CMS-lite, repo markdown)
```
platform/content/site/
  compare/{vs-hiring-an-agency,vs-diy,vs-ai-chat}.md
  stories/ipop-marketing.md
  guides/{how-ai-agents-run-an-seo-audit,marketing-automation-with-approval-gates}.md
  changelog/2026-06-week-2.md
```
Each file: YAML-ish frontmatter (`title, slug, description, kind, agent, date, status`, plus
section-specific keys like `competitor`/`metrics`) + a markdown body. `status: published` is the only
content served publicly; `status: draft` is invisible until the gate clears and a human commits the flip.

### Server (apps/server)
- `src/site/frontmatter.ts` — pure `parseFrontmatter(raw)` / `serializeFrontmatter(meta, body)`,
  dependency-free (no `gray-matter`).
- `src/site/content.ts` — `ContentSource` seam (`list(section)` / `read(section, slug)`), typed
  `SiteDoc`, `loadSection` / `loadDoc` filtering to `published`. Pure given a source.
- `src/site/markdown.ts` — pure `renderMarkdown(md): Block[]` → headings / paragraphs / lists /
  quotes / code, with inline `**bold**` and `[text](url)` links. Returns typed blocks (no
  `dangerouslySetInnerHTML`, so no XSS) for the React renderer.
- `src/site/changelog.ts` — pure `parsePrTitle(title)` (conventional-commit type/scope/summary) and
  `draftChangelog(prs, weekOf)` → `{ title, summary, body }` in the house voice, grouped Features /
  Fixes / Improvements, attributed to `echo`.
- `src/site/publish.ts` — pure `buildContentPublish({ section, slug, title, agent })` →
  `external.send` descriptor (`kind: "content.publish"`), submitted through the existing #13 path.
- `src/routes/site.ts` — **public** (no auth) `GET /site/content/:section`,
  `GET /site/content/:section/:slug`, `GET /site/changelog` over a default disk `ContentSource`
  rooted at `content/site` (overridable for tests / deploys).

### Web (apps/web)
- `routing.tsx` — unchanged seam; pages parse params from `useRoute()` (`/compare/vs-diy`).
- `AuthGate.tsx` — a `matchMarketingRoute(path)` runs **before** the phase checks so the marketing
  site is public for everyone (anon *and* signed-in), lazy + code-split.
- `components/site/` — `SiteShell` (shared nav + the "maintained by quill" footer + Ask-AI deep
  links), `Compare`, `CompareDoc`, `Stories`, `StoryDoc`, `Guides`, `GuideDoc`, `Changelog`, `Brand`,
  `Markdown` (renders `Block[]`), `SoftPaywall` (the cap-hit nudge → pricing).
- `brand.ts` — new `COMPARE` / `STORIES` / `GUIDES` / `CHANGELOG` / `BRAND_ASSETS` / `ASK_AI` /
  `PAYWALL` copy blocks; `askAiLinks(prompt)` URL builder. `brand.test.ts` extends the
  no-hardcoded-strings scan to the new components.
- `api/client.ts` — a `site` sub-object (`getSection`, `getDoc`, `getChangelog`).

### The machine loop (how the fleet builds + maintains it)
1. **Draft** — a human briefs `@quill` (or `@scout`/`@echo`) in the content channel; the existing
   #123 @mention path launches a **venture-gated, draft-only** session that writes the markdown.
2. **Gate** — publishing the draft submits `buildContentPublish(...)` as an `external.send` action to
   `POST /workspaces/:wid/actions`; it is **sensitive by default → a pending human approval**.
3. **Publish** — the owner approves in the existing Approvals panel; the gate clears; the markdown is
   committed with `status: published` and the public site serves it.

## Acceptance criteria → evidence

| # | Criterion | Evidence |
|---|-----------|----------|
| 1 | `/compare/*` honest brand-voice SEO pages | 3 committed markdown files; `Compare`/`CompareDoc` render; route test |
| 2 | `/stories` CMS-lite, ipop dogfood story w/ real metrics | `ipop-marketing.md` w/ venture-loop metrics; `Stories`/`StoryDoc` test |
| 3 | `/changelog` auto-drafted from PR titles, gated publish | `draftChangelog` unit tests; seeded entry; `external.send` gate integration test |
| 4 | `/guides` 2–3 cornerstone pieces | 2 committed guides; `Guides`/`GuideDoc` test |
| 5 | Trial funnel + soft paywall → pricing | `SoftPaywall` wired to #125 plans/402; component test |
| 6 | Ask-AI deep links (ChatGPT/Claude/Perplexity) | `askAiLinks` unit test (prefilled prompt, encoded); footer test |
| 7 | `/brand` assets page from docs/brand | `Brand` page renders marks/wordmark/palette; test |
| twist | every page footed "maintained by quill" | `SiteShell` footer test asserts the credit on every page |

## Testing

- **Server unit** (`npm test`, no DB): frontmatter round-trip, content loader filtering, markdown
  blocks + inline, `parsePrTitle`/`draftChangelog`, `buildContentPublish`.
- **Server integration** (`npm run test:integration`, real PG): public `/site/*` endpoints over a
  fixture content source; the gated-publish loop — POST the `content.publish` descriptor to `/actions`
  → 202 pending → owner approve → executed (proving every publish is #13-gated).
- **Web** (`vitest`): each page renders from injected content; `SiteShell` footer credit + Ask-AI
  links; `SoftPaywall` nudge; `brand.test` no-hardcoded-strings on the new components.
