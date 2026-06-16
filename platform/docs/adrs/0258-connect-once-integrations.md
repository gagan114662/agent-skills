# ADR-0258: Connect-once integrations — the agents own real-world setup, not the user (Stage 1)

- **Status:** Accepted (shipped in PR for #258, also closes #263)
- **Date:** 2026-06-16
- **Context issue:** [#258](https://github.com/gagan114662/agent-skills/issues/258) — ipop's promise is
  "a user enters their domain and the agents run their marketing." Every real-world hookup used to be a
  manual infra chore (set a GitHub token via `fly secrets`, paste keys in Settings). The only two things
  that need a human are (a) a one-time CONSENT to access an outside account and (b) spending money. The
  agents should own everything else.
- **Also closes:** [#263](https://github.com/gagan114662/agent-skills/issues/263) — zero free-text secret
  inputs left in the user-facing Settings UI.
- **Money-only gate:** [ADR-0243](0243-money-only-approval.md) — connecting an account is a CONSENT, not
  money, so it carries no #13 approval. Real spend through a connected channel stays money-gated, unchanged.
- **Quarantine:** [#223](https://github.com/gagan114662/agent-skills/issues/223) — `publish_site` stays a
  PR-only actuator (no send/spend seam); a poisoned web read can at most draft a PR a human still merges.
- **Builds on:** [ADR-0192](0192-external-account-onboarding.md) (the write-only encrypted credential
  vault this stores connections in), [ADR-0231](0231-real-world-tool-surface.md) (the real-world tool
  surface + "Connect external accounts" Settings pattern), [ADR-0250] self-publish-to-ipop.ai (#250)
  (the GitHub-PR publishing this generalises behind an interface).

## Decision

ipop's customers are **non-technical**. They must never see GitHub, repos, PRs, CLIs, or tokens. So:

1. **`publish_site` calls an abstract `SitePublisher`** (`realworld/publish/site-publisher.ts`), not a
   concrete GitHub provider. Two impls slot in as first-class:
   - `GitHubSitePublisher` — ipop.ai's OWN **internal** mechanism. Commits a content file + opens a PR
     against ipop's site repo, using a token resolved from the **per-workspace encrypted connection**
     (#192 vault), NOT a Fly server secret. Admin/owner only; a customer never sees it.
     `GitHubSitePrProvider` now takes an **injected token** (the connection) — env vars are a back-compat
     fallback only.
   - `IpopHostedSitePublisher` — the customer default to come (multi-tenant pages on the customer's own
     domain via a one-time CNAME / ipop subdomain, zero repo, zero setup). Stubbed so the abstraction is
     provably first-class; the live impl + the "Connect your website" OAuth flow ship in the follow-up.

   `resolveSitePublisher(workspaceId, deps)` picks the impl: the per-workspace internal GitHub connection
   first, then a legacy env-token config path, then a dry-run publisher (the safe internal default — no
   network, exercisable end to end). The customer-facing resolution lands in the follow-up behind the
   same interface.

2. **The connection model is OAuth-first** (`connections/registry.ts`). Customer connectors are consumer
   OAuth — "Sign in with Google" (one consent covering Search Console + Analytics), "Connect X",
   "Connect LinkedIn", "Connect your website" (Webflow/WordPress). The live OAuth redirect is the
   follow-up, so customer connectors render as `coming_soon` today, but the descriptors are already
   OAuth-shaped (provider, scopes, capabilities) so the redirect slots in without re-modelling. The only
   `paste_internal` connector is the GitHub site-publish one — INTERNAL/admin, never offered to a
   customer. `decideInternalConnect` refuses a non-owner and refuses pasting an OAuth connector outright.

3. **`GET /me/connections`** lists what a workspace can connect (+ connected state). The internal GitHub
   connector is listed only for the owner workspace (`marketing.ownerWorkspaceId`, now also settable from
   the env via `RELOAD_MARKETING_OWNER_WORKSPACE_ID`). `POST /me/connections/:id/connect` is the internal
   paste path (admin only); `POST /me/connections/:id/oauth/start` is the consumer-OAuth seam (501
   `coming_soon` today, honest). Disconnect revokes the vault row → the capability goes offline.

4. **Zero free-text secret inputs in user-facing Settings (#263).** Every existing secret-paste field —
   Connect Claude's setup token, Slack's bot token + signing secret, the external-accounts key/token, and
   the internal GitHub token — is moved behind a collapsed `<details>` "Advanced" disclosure (or, for
   GitHub, the owner-only admin surface). The default view shows a Connect affordance, never a free-text
   secret field. OAuth-capable customer connectors live in the OAuth-first Connections panel.

## Consequences

- The GitHub publish token is no longer a Fly server secret — it's an encrypted per-workspace connection,
  so any workspace connects its own publishing once and Scout/Quill publish autonomously.
- The customer-facing ipop-hosted publishing + the live Google/social OAuth redirects are the explicit
  follow-up (next issue), but the interfaces (`SitePublisher`, the OAuth-shaped registry, the
  `/oauth/start` seam) are already in place so they are incremental.
- Default-OFF / back-compat preserved: with no connection and no GitHub config, `publish_site` resolves to
  the dry-run publisher exactly as before (no network).
