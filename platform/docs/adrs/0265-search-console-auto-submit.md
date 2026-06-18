# ADR-0265: Scout auto-submits the sitemap + requests indexing after Google connect

- **Status:** Accepted (shipped in PR for #265)
- **Date:** 2026-06-18
- **Context issue:** [#265](https://github.com/gagan114662/agent-skills/issues/265) — users were told to
  open Search Console and click "Request Indexing" by hand. After the Google connection Scout should submit
  the sitemap and request indexing for new/changed URLs on its own, and read coverage so indexed-page
  numbers appear in the SEO scorecard automatically. Acceptance: no manual Search Console steps, and
  indexed-page + ranking numbers surface in the scorecard.
- **Builds on:** [ADR-0260](0260-onboarding-google-oauth.md) / #260 (the one-screen Google consent that
  already requests the `webmasters` Search Console write scope and seals the tokens into the #192 vault
  under `service_key="google"`), [ADR-0294](0294-technical-seo-rank-tracking.md) / #294 (the externally-
  grounded rank-observation store — the ranking half of the scorecard, untouched here), [ADR-0231](0231-real-world-tool-surface.md)
  (the gated actuator pattern this copies: park a PENDING #13 request, execute only post-approval, record a
  durable receipt for every outcome), [ADR-0013](0013-approval-gates.md) (the human-approval gate),
  [ADR-0243](0243-money-only-approval.md) (money-only default + the structural always-gate carve-out for
  non-money irreversible actions), [ADR-0223](0223-injection-quarantine.md) / [ADR-0200](0200-premortem-panel.md)
  §4/§6 (irreversible-action pre-commitment + injection quarantine), [ADR-0035](0035-config-layering.md)
  (layered default-OFF, owner-workspace-first feature config).

## Context

The Google connection (#260) already grants the Search Console **write** scope (`webmasters`) and stores
the OAuth tokens in the per-workspace #192 vault. The rank-tracking store (#294) already feeds *rankings*
into the scorecard from external receipts. The gap #265 names is the **write side**: nothing actually calls
the Search Console API to (a) submit the sitemap and (b) request indexing for new/changed URLs, and nothing
reads *coverage* (the indexed-page count) back into the scorecard. Users were still doing this by hand.

Submitting a sitemap and requesting indexing are **outward live actions against a real Google production
surface**. The premortem (#200) makes three demands on any such action:

- **§4 reversibility / pre-commitment.** An external grant/submit is not cheaply reversible post-hoc.
  Indexing requests are quota-limited and touch Google's crawl scheduler. So the live submit must be
  **pre-committed and human-gated**, never agent-initiated and never post-hoc review.
- **§2 external receipts only.** "Submitted successfully" may not be true. We must **verify against the
  real Search Console API** (`sitemaps.get` → was the sitemap accepted, is it pending, did it error;
  coverage → how many pages are actually indexed) and only ever report what the provider confirms. Never
  assume success.
- **§6 injection quarantine.** Scout reads web pages. A poisoned page must never be able to steer us into
  pinging a foreign URL or submitting a foreign sitemap. The sitemap URL and the indexing URL list are
  **structural DATA**, sanitized, and **same-origin-locked** to the workspace's own site.

## Decision

A new server module `apps/server/src/search-console/` — modeled exactly on the #231 gated actuator and the
#294 external-receipt store — with **three independent safety layers** so the feature ships safely OFF:

1. **Feature flag, default OFF, owner-workspace-first.** A new `seo.autoSubmitSitemap` flag (resolved by
   `resolveSearchConsoleCaps` off the existing `seo` config block — no new config block) plus the existing
   `seo.ownerWorkspaceId` marker. `searchConsoleAutoSubmitEnabledForWorkspace(caps, workspaceId)` is true
   only when the flag is on AND the workspace is the owner's (or no owner pin is set). With the flag off,
   `submitSitemap` returns `disabled` and touches nothing.

2. **Structural #13 always-gate (no autonomous submit path).** `SearchConsoleService.submitSitemap` can
   **only** park a PENDING `searchconsole.submit` approval — there is no code path that submits without a
   prior human approval. Like `connection.connect_account` / `hosted.publish` (ADR-0258/0266) the action is
   **not money** (so it is not in `MONEY_ACTIONS`) and is reversible (a sitemap can be resubmitted/removed,
   so not in `IRREVERSIBLE_ACTIONS`); the always-gate is enforced by the service's shape, not by the money
   predicate. The live submit happens only through `executeApprovedSubmission`, the post-approval executor.

3. **Dry-run provider by default (no credentials wired).** The `SearchConsoleProvider` seam defaults to
   `DryRunSearchConsoleProvider`, which makes no network call and honestly returns "not submitted /
   unverified". A `LiveSearchConsoleProvider` (fetch-backed, reads the `google` vault tokens) is defined but
   `resolveSearchConsoleProvider` returns the dry-run provider until an owner wires a credential — exactly
   the #294 rank-provider posture. **This PR connects no real Google account and submits nothing live.**

### Verification touches reality (premortem §2)

`executeApprovedSubmission` never trusts its own call. After `submitSitemap` + `requestIndexing`, it calls
`provider.getSitemap` and runs the **pure** `decideSitemapVerification` — the row is recorded as `verified`
only when Search Console itself reports the sitemap present with zero errors; otherwise it is `submitted`
(pending) or `failed`, with the provider's own counts. Coverage flows through `decideCoverageReading`,
which returns `null` (never a fabricated number) when the response is unparseable. With the dry-run provider
every outcome is honestly "unverified", so the scorecard stays "not connected" until a real provider
confirms — never a self-reported figure.

### Injection quarantine (premortem §6)

`decideSitemapSubmission` is pure and fail-closed: it parses the site origin, defaults the sitemap to
`${origin}/sitemap.xml`, and **drops any sitemap or indexing URL whose origin is not the site's own** and
any control characters. A poisoned web read folded into a request can therefore never cause a submit/ping
against a foreign host — the worst case is a no-op plan.

### Persistence + scorecard

A workspace-scoped `search_console_submissions` receipt table (migration `0265`, named `search_console_*`
so the #155 colocation gate does not class it as a governed metric surface) records every submission attempt
and its **verified** status + indexed-page count. The founder-console SEO tile folds the latest verified
indexed-page count into its note, so coverage appears automatically once a real provider confirms.

### Route

`/me/seo/search-console/*` (summary + submit) — thin adapters over the service, workspace-scoped (#3).
`submit` can only ever return `pending_approval` / `disabled` / `not_connected` / `rejected`.

## Consequences

- **Owner-activatable, safe by default.** Three independent gates (flag OFF, #13 approval, dry-run provider)
  each individually prevent any live Google call. The owner turns the feature on, approves the first submit,
  and wires a live provider credential — each an explicit, reversible step.
- **No fabricated proof.** The scorecard can only ever show externally-confirmed indexed-page / ranking
  numbers; with no live provider it stays honestly "not connected".
- **Follow-up (deliberately not in this slice):** the `LiveSearchConsoleProvider` credential wiring behind
  the #192 vault, and Scout proactively calling `submitSitemap` from the publish/{{site}} brief seam after a
  new page ships. Both ride this module unchanged.
