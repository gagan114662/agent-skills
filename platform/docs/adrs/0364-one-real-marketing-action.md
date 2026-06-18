# ADR-0364: One real marketing action end-to-end — an approved SEO deliverable ships as a real on-site PR

- **Status:** Accepted (shipped in PR for #364)
- **Date:** 2026-06-18
- **Context issue:** [#364](https://github.com/gagan114662/agent-skills/issues/364) — part of epic
  [#359](https://github.com/gagan114662/agent-skills/issues/359) ("make the reload.chat vision real on
  ipop.ai"). Every real-world action is dry-run / `coming_soon`, so the fleet ships nothing real: the board
  reaches "Approval needed" (the #295 approve→publish wiring exists) but the executor side stays simulated.
  Pick the **single lowest-risk live path** and wire it end-to-end (owner workspace only) so a briefed agent
  produces a deliverable that — once approved at the **#13** gate — performs a REAL marketing action for
  ipop.ai and records an external-grounded receipt.
- **Builds on:** [ADR-0295](0295-deliverable-delivery.md) (the approve→publish dispatcher this extends —
  the owner's #13 approval is the ship trigger; nothing ships without an `approvalRequestId`),
  #250 (the `publish_site` self-publish-to-ipop provider — `GitHubSitePrProvider` / `SitePublisher` — the
  actuator this reuses), [ADR-0258](0258-connect-once-integrations.md) (the
  `SitePublisher` seam + per-workspace site-publish connection), [ADR-0231](0231-real-world-tool-surface.md)
  (live-URL + HEAD readback verification), [ADR-0243](0243-money-only-approval.md)/[ADR-0013](0013-approval-gates.md)
  (the #13 queue), [ADR-0357](0357-owner-activation-profile.md) (the owner-gated activation profile that
  flips this on), [ADR-0200](0200-premortem-panel.md) (the standing premortem rails).

## Context

The whole epic turns on **one real deliverable actually leaving the building** for ipop.ai. The #295
dispatcher already routes an approved `agent.deliverable` to a channel adapter and records a receipt tied to
the #13 approval — but its live channels are dry-run: the `publish` channel ships a brand-new standalone
GitHub Pages page, and `social`/`email` are hard-wired to dry-run providers. Meanwhile the `publish_site`
provider (#250) — which commits a content file and opens a **real pull request against ipop's own site
repo** — is reachable today only through the **autonomous** `publish_site` tool (money-free + reversible ⇒
no gate under #243). No briefed SEO/content deliverable can become a real on-site change **through the #13
gate**.

## Decision

Wire **one** lowest-risk live path: an approved SEO/content deliverable ships as a **real on-site content
PR** against ipop's own site repo, through the #295 dispatcher, behind a new owner-first delivery channel.

### Why this is the single lowest-risk path (the #364 choice)

Candidates were Postmark email live-send (#268), Echo social post (#269), and an on-site SEO change
(#294/#250). We chose the **site PR**:

1. **Reversible.** A PR is a review surface — it changes nothing on the live site. Closing/reverting the PR
   fully undoes it; **merge/deploy stays a separate human action on GitHub**. (Email/social are irreversible
   the instant they leave the building.)
2. **Money-free.** Opening a PR spends nothing (vs ads spend).
3. **No third-party OAuth, no per-customer credential.** ipop owns the repo; auth is a single server-side
   GitHub token read from the secret env at publish time (never config). Email needs an ESP + a verified
   sending domain + a delivered-message deliverability proof; social needs an aggregator OAuth.
4. **Strong external proof.** The GitHub API returns a real PR `html_url`; we `GET`-readback the URL for a
   2xx to PROVE it answers (#200 §3) — the acceptance's "live URL + HEAD 2xx readback".
5. **Owner-controlled blast radius.** Content lands on ipop's own repo, behind a human merge.

This path is also **stricter** than the existing autonomous `publish_site` tool: the same actuator now sits
behind the owner's per-deliverable #13 approval.

### What changed (additive, default-OFF, owner-first)

- **`delivery/decide.ts`** — a new `site_pr` channel (reversible), a `site_pr` flag (default OFF), and a
  pure `routeDeliveryChannel(department, flags)` that redirects a content/SEO publish to `site_pr` **only**
  when the owner-first `delivery.sitePr` flag is on. Flag OFF (the default and every other tenant) ⇒ routing
  is byte-for-byte the structural mapping (content/SEO → standalone `publish` page).
- **`delivery/adapters.ts`** — `SitePrChannelAdapter`, which ships through the existing `SitePublisher`
  seam. The draft is **opaque DATA**: it is committed verbatim as the file body; the slug/path/branch are
  derived **structurally** from the task title by `decidePublishToIpop` (traversal-proof, `[a-z0-9-]`), so
  injected instructions in the draft can never escape the content dir, retarget the repo, or redirect the
  ship (#200 §6). `live` is true **only** when an injected `GET` readback confirms the PR url answers 2xx
  (#200 §3). `not_connected`/`rejected`/`failed` ⇒ `ActionExecutionError` (a `failed` receipt + the #13
  request marked failed — never a silent success).
- **`delivery/default.ts`** — `resolveSitePrDelivery()` selects the live provider from the workspace-agnostic
  base config (`realworld.sitePrProvider = "github"` + `siteRepo`), mirroring `resolvePublishProvider()`.
  With that unset (the default) it is the dry-run provider — **no network egress**, no readback, recorded
  honestly as `live:false`.
- **`config/schema.ts`** — `delivery.sitePr` (optional, default OFF).
- **`deploy/managed.owner-activation.example.toml`** (#357) — a `delivery` block (enabled, owner-first,
  `sitePr = true`; the standalone-page/social/email channels explicitly OFF so the one path is exercised in
  isolation). The **live provider** stays a commented `sitePrProvider`/`siteRepo` placeholder — until the
  owner names the repo, the site-PR ship is a dry-run. Flipping the live provider is the owner-gated #357
  step, **not** done in this PR.

## Rails (#200) honored

- **#13 gate (§4).** No new autonomous path. The owner's deliverable approval IS the trigger; the #295
  dispatcher refuses to ship without an `approvalRequestId`, and the receipt is tied to it.
- **External receipt (§3).** `live` reflects a real PR-url HEAD/GET readback; a dry-run never claims a live
  PR. We never fabricate a shipped state.
- **Injection (§6).** Routing is a pure function of (department, flags); the draft is committed DATA, never
  parsed for routing or path.
- **Reversible, default-OFF, owner-first, build + PR only.** A PR is reversible; the channel is OFF unless
  the master flag is on AND the workspace is the named owner; no prod flag is flipped in this PR.

## Consequences

- The fleet can complete **one real, #13-approved marketing deliverable** for ipop.ai end-to-end once the
  owner sets `delivery.enabled + sitePr` and `realworld.sitePrProvider = "github" + siteRepo` via the #357
  profile and provides the GitHub token on the secrets path.
- The other paths (email #268, social #269, standalone publish) remain explicitly out of scope and dry-run.
- Merging/deploying the PR to the live site is intentionally **not** automated — it stays a human action on
  GitHub, which is the property that makes this the lowest-risk first real action.

## Alternatives considered

- **Postmark email live-send (#268).** Rejected as the *first* path: irreversible, needs an ESP + verified
  domain + a delivered-message `Authentication-Results` proof (a chicken-and-egg for the first send) + an
  owner recipient. Higher blast radius and surface than a reversible PR. Still the natural second path.
- **Echo social post (#269).** Rejected first: a public post is irreversible and needs aggregator OAuth.
- **New autonomous `publish_site` from the brief.** Rejected: #364 requires the action to stay on the #13
  gate. Reusing the #295 dispatcher keeps the owner's approval as the trigger.
