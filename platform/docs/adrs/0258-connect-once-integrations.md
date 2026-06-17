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

## Stage 2 — the shared, gated live connect-once seam

Stage 1 left the customer-OAuth connectors as an honest `coming_soon` stub. Stage 2 builds the **reusable
connect-once seam** the per-department follow-ups depend on (Google Search Console for Scout **#265**, an ESP
for Postmark **#268**, social for Echo **#269**, an ad account for Bid **#272**). Each follow-up registers
ONE provider behind this seam and the gated flow, vault seal, and capability resolution work unchanged.

**Hard boundary (this PR):** no real provider account is connected and no credential is entered. We build the
flow, the adapters, the mocks, and the tests; the live OAuth/connect action stays **gated, default OFF, owner
-workspace-first** so only the owner can ever turn it on and only with an explicit per-connect approval.

1. **Pure seam (`connections/`):**
   - `caps.ts` — `ConnectOnceCaps` + `isConnectOnceLiveInScope`: default OFF, owner-workspace-first (mirrors
     `connectClaude`/`delivery`/`skillopt`). Fail-closed: `enabled` without naming the owner lets nobody in.
   - `state.ts` — HMAC `state` binding `{workspaceId, connectionId, nonce}` (CSRF + anti-tenant-cross +
     connection binding), no DB row (generalises the #260/#262 state).
   - `provider.ts` — the `ConnectProvider` adapter seam (`authorizeUrl` + `exchange` → granted capabilities +
     secrets). `DryRunConnectProvider` never mints (premortem §3 — an unwired deployment degrades to an honest
     `coming_soon`, never a fake connected); `MockConnectProvider` is a TEST/DEMO double returning a clearly
     synthetic, non-secret placeholder (no real credential, no network); `OAuthConnectProvider` is the generic
     live authorization-code adapter a follow-up constructs; `isValidAuthCode` is the §6 injection screen.
   - `connect.ts` — `decideConnectStart` (the offer/gate decision) and `mapExchangeToSeal` (the never-seal-a
     -blank rule: an exchange with no usable credential can never mark a connection connected).
   - `capabilities.ts` — `decideConnectedCapabilities`: the read side the follow-ups gate on ("is
     `search_console` connected before Scout verifies the domain?", #265).

2. **Always-gate (`connection.connect_account`).** Connecting is a CONSENT, not money (ADR-0243), so it is
   NOT in `MONEY_ACTIONS`. But it touches a real external surface (premortem §4), so the connect-once service
   ALWAYS parks a PENDING `connection.connect_account` #13 request — a structural always-gate (no autonomous
   -connect path), exactly like `hosted.publish`/`skillopt.adopt_skill_edit`. The executor is **recorded-only**:
   approving records the owner's go; the live redirect + token exchange + vault seal behind the gate is the
   per-department follow-up, never an autonomous mint in this slice.

3. **Config + route.** New `connectOnce` config block (`RELOAD_CONNECT_ONCE_ENABLED` /
   `RELOAD_CONNECT_ONCE_OWNER_WORKSPACE_ID`, default OFF). `POST /me/connections/:id/oauth/start` now routes
   through `ConnectOnceService`: out of scope (flag off / not the owner / no live provider wired) ⇒ the honest
   `501 coming_soon` (Stage 1 behavior, unchanged); in scope + live ⇒ `202` with the parked approval id. With
   no live provider wired in this slice, every deployment still resolves to `coming_soon` — the seam is in
   place, the live connect is one provider registration away, and it is owner-gated the whole way.

- No migration (config-resolved + the existing #192 vault + #13 `approval_requests`). Back-compat preserved:
  with `connectOnce` unset, the connect surface behaves byte-for-byte like Stage 1.
