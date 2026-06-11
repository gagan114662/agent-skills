# ADR-0153: The marketing-site machine, maintained by the fleet

- **Status:** Accepted (shipped in PR for #153)
- **Date:** 2026-06-11
- **Context issue:** [#153](https://github.com/gagan114662/agent-skills/issues/153)
- **Spec:** [docs/specs/153-marketing-site-machine.md](../specs/153-marketing-site-machine.md)
- **Builds on:** **#149** (PR #154 — public landing, the dependency-free `routing.tsx`, `AuthGate`
  phase+route boundary, code-split public surfaces),
  [ADR-0013](0013-approval-gates.md) (#13 `external.send` sensitive-by-default gate),
  [ADR-0123](0123-marketing-department-fleet.md) (#123 draft-only named fleet + `@mention →
  venture-gated session`), [ADR-0125](0125-pricing-plans.md) (#125 plan catalog + `GET /billing/plans`),
  [ADR-0138](0138-pop-identity-channels-deploy.md) (#138 pop brand + committed brand book).

> **Numbering note.** Spec / ADR use the `0153` slot (the issue number), per the project's by-issue
> numbering convention (ADR-0099's note). **No migration ships** — additive read-models + pure modules
> over existing repos — so there is zero shared-sequence collision surface.

## Context

ona.com and incident.io both run a *marketing machine*: comparison/alternatives pages, customer
stories, an auto-drafted changelog, cornerstone SEO guides, and a self-serve trial. ipop had exactly
one public page (#149's landing) and nothing behind it. The owner directive carries a twist that is
also the strongest possible demo: **the fleet that ipop sells should build and maintain its own
marketing site** — every page footed *"maintained by quill, our content agent"*, every publish
approval-gated, and content generation routed through the real #123 task path.

The hard parts are not "render some markdown". They are: (a) a CMS-lite that does not become a CMS;
(b) making *publish* genuinely gated by #13 without adding a new action type or executor (which would
touch the core approval engine every workspace shares); (c) keeping public marketing pages public for
**signed-in users too** without colliding with #149's anon-only landing branch; (d) a soft paywall that
nudges honestly off the **real** #125 plan state and the **real** #71 admission denial, not a fake
counter; and (e) shipping it **migration-free and additive** so nothing existing weakens.

## Decisions

1. **Content is repo markdown, served read-only — a CMS-lite, not a CMS.** `content/site/{compare,
   stories,guides,changelog}/*.md` with frontmatter. A pure, dependency-free `parseFrontmatter`
   (no `gray-matter`) and a `ContentSource` seam (disk by default, in-memory for tests) keep the
   loader unit-testable. Public `GET /site/content/*` endpoints serve only `status: published`.
   Editing the site is a pull request — which is exactly how every other artifact here becomes real.

2. **Markdown renders to typed `Block[]`, never to raw HTML.** `renderMarkdown` returns a discriminated
   union (heading/paragraph/list/quote/code with inline bold + links); the React `Markdown` component
   maps blocks to elements. No `dangerouslySetInnerHTML` ⇒ no XSS, and the renderer is a pure unit.

3. **Publish reuses the existing #13 `external.send` gate verbatim — no new action type.** A pure
   `buildContentPublish({section, slug, title, agent})` shapes an `external.send` descriptor with
   `payload.kind = "content.publish"`. It is submitted through the unchanged `POST /workspaces/:wid/
   actions` path; `external.send` is sensitive-by-default, so a publish is **always** a pending human
   approval, executed recorded-only. `policy.ts` and the executor registry are untouched. This is the
   same pattern #123 used for outbound sends (`buildMarketingSend`) — publishing a page is just another
   thing that "leaves the building".

4. **Content generation routes through the #123 fleet, not a new launcher.** Drafting is the existing
   `@quill`/`@scout`/`@echo` @mention path (venture-gated, draft-only tools, no send). #153 adds the
   storefront those drafts land on and the gated publish in front of it; the seeded cornerstone content
   credits its author agent in frontmatter (`agent: quill`) and every page is footed *"maintained by
   quill"*. No parallel content-task service, no new persona, no new gate.

5. **Marketing routes are public for everyone, matched before the phase checks.** `AuthGate` runs a
   `matchMarketingRoute(path)` first: a marketing path renders its lazy page regardless of `phase`
   (anon, ready, even offline — the pages fetch their own content and degrade gracefully). This makes
   the storefront a true public site rather than an anon-only screen (#149's landing stays the anon
   `/` fallback), and signed-in users can read `/compare` without being bounced into the app.

6. **The soft paywall nudges off real state, not a fake counter.** `SoftPaywall` surfaces the current
   #125 plan (`GET /billing/plans → current`) and the **real** #71 admission denial (the `402`/`429`
   the launch path already returns), then links to the pricing surface. The trial *is* the preloaded
   workspace from signup (#123 auto-seed) — "Start free" is the existing signup CTA; #153 only adds the
   honest nudge when a cap is actually hit.

7. **Ask-AI deep links are a pure URL builder.** `askAiLinks(prompt)` returns the ChatGPT / Claude /
   Perplexity URLs with the prompt URL-encoded into each provider's query param. Pure ⇒ unit-tested;
   rendered in the shared footer (the GEO play both reference machines run).

8. **No migration, no config block.** Public pages always render (like #149's landing — marketing is
   never gated behind a flag). The publish gate is opt-in by virtue of requiring an explicit action.
   Skipping a `site` config block avoids the `config/layers.ts` dual-merge gotcha and keeps the blast
   radius to additive new files.

## Consequences

- **Positive:** Migration-free and sibling-safe; the publish gate is the *real* #13 gate, proven by an
  integration test against the unchanged `/actions` path; the site is the most honest demo of the
  product (the fleet maintains it); content is version-controlled and reviewable as PRs; no XSS surface.
- **Negative / trade-offs:** "Publish" does not flip a live bit at runtime — it clears the gate in
  front of a human committing the markdown (acceptable: matches the repo's commit-is-truth model, and a
  future PR can add a runtime override registry if dynamic publishing is wanted). The "weekly" changelog
  cadence is operational (a GitHub Action calling the drafter), not an in-process scheduler — same
  posture as #99/#108 drills; this PR ships the pure drafter and a seeded first entry.
- **Follow-ups:** wire a `changelog-draft.yml` Action to open a gated draft each week; a runtime
  publish-override table if dynamic (non-committed) content is ever needed; per-page OpenGraph images.
