# ADR-0262: Connect Claude without a CLI token — replace `claude setup-token` with a Connect button

- **Status:** Accepted (shipped in PR for #262)
- **Date:** 2026-06-17
- **Context issue:** [#262](https://github.com/gagan114662/agent-skills/issues/262) — enabling the fleet
  required running `claude setup-token` in a terminal and pasting the result into Settings. That is
  impossible for a non-technical user. The fix: a one-click, in-app "Connect Claude" flow managed by ipop.
  Acceptance: a user enables the agents without ever opening a terminal or pasting a token.
- **Money-only gate:** [ADR-0243](0243-money-only-approval.md) — connecting an account is a CONSENT, not
  money, so it carries no #13 approval (consistent with the #258 non-money connects).
- **Premortem:** [#200](https://github.com/gagan114662/agent-skills/issues/200) — see "Honoring #200" below.
- **Builds on:** [ADR-0068] subscription-only agent auth (the `workspace_agent_credentials` #68 vault this
  seals the token into), [ADR-0258](0258-connect-once-integrations.md) (the OAuth-first connect-once model
  this extends to the Claude credential), the #260 Google OAuth scaffolding (`auth/oauth-state.ts` HMAC
  state, `loadGoogleOAuthConfig` env pattern, the dry-run-by-default provider seam) which this mirrors.

## Decision

ipop's customers are **non-technical** and must never see a terminal. So the Claude credential becomes an
in-app, OAuth-shaped consent — reusing the exact seams already in the codebase rather than inventing new
ones — defaulting OFF and owner-workspace-first.

1. **A pure decision brain + provider seam** (`auth/claude-connect.ts`):
   - `resolveConnectClaudeCaps` / `isConnectClaudeInScope` — the policy: `enabled` defaults **OFF**,
     `ownerWorkspaceOnly` defaults **true**, and scope is **fail-closed** (an unset owner id lets *nobody*
     in, never everybody). Mirrors `agent-registry/caps.ts`.
   - `decideClaudeConnectOffer` — what Settings features: out of scope ⇒ today's `paste_token`; in scope +
     a live client ⇒ `managed_oauth` `available`; in scope without a live client ⇒ an honest
     `coming_soon`. The manual setup-token paste **always remains available** behind the #263 Advanced
     disclosure, so a workspace is never left unable to connect.
   - `ClaudeConnectProvider` — `DryRunClaudeConnectProvider` (the default: `live:false`, never mints a
     token) and `LiveClaudeConnectProvider` (real OAuth code exchange, constructed ONLY when a live client
     is configured). `createClaudeConnectProvider(env)` picks between them, and the route reads
     `provider.live` for the offer — so "what we show" and "what happens" can never disagree.

2. **Reuses storage, not a new table.** A minted token is sealed into the SAME #68
   `workspace_agent_credentials` vault the manual paste already writes (`setWorkspaceClaudeToken`), so the
   #246 subscription-only runtime auth path is byte-for-byte unchanged. **No migration.**

3. **Routes** (`routes/claude-connect.ts`, all `/me/*`-scoped):
   - `GET  /me/claude/connect` — the offer (read-only, never a secret).
   - `POST /me/claude/connect/start` — mints an HMAC-signed, **workspace-bound** OAuth `state` (no DB) and
     returns the consent URL; honest `409` (not enabled) / `501` (`coming_soon`) when it can't run.
   - `GET  /me/claude/connect/callback` — verifies the state (CSRF + tenant binding), validates the
     untrusted `code`, exchanges it, and seals the token; then redirects back to the board.

4. **Config / rollout.** A `connectClaude` block (default OFF, owner-first) layered like every other block,
   opt-in-able from the env via `RELOAD_CONNECT_CLAUDE_ENABLED` / `RELOAD_CONNECT_CLAUDE_OWNER_WORKSPACE_ID`
   (the owner-first marker also falls back to the canonical `marketing.ownerWorkspaceId`). The OAuth client
   itself is env-driven (`CLAUDE_OAUTH_*`) and never in the non-secret config, so even `enabled: true`
   stays `coming_soon` until a real client is wired — **no credentials are added in this PR.**

5. **UI.** `ConnectClaude` gains an optional offer: a one-click "Connect Claude account" button when the
   managed flow is available, an honest coming-soon note otherwise; the setup-token paste drops to a
   power-user fallback under Advanced. The headline copy and the @mention connect prompt no longer tell a
   non-technical owner to run a terminal command.

## Honoring #200 (premortem)

- **§3 production-grounded:** nothing real is minted unless a live client is configured AND the provider
  returns a non-empty token; the dry-run default degrades to an honest `coming_soon`, never a fake
  "connected".
- **§4 reversibility:** connecting is reversible (Disconnect clears the vault) and is consent, not money —
  no #13 gate.
- **§6 injection defense:** the OAuth callback `code`/`state` are untrusted. `isValidAuthCode` rejects
  anything that isn't a bare URL-safe code *before* it can reach a token exchange, and the HMAC-signed
  state binds the callback to its originating workspace (anti-CSRF + anti-tenant-cross) with no DB.

## Consequences

- A non-technical owner can bring the fleet online without a terminal once the live OAuth client is wired;
  until then the surface is an honest coming-soon with the paste fallback intact.
- The live Anthropic OAuth client (`CLAUDE_OAUTH_*`) + PKCE is the explicit follow-up; the seam, state,
  validators, and storage are already in place so it is incremental.
- Default-OFF / back-compat preserved: with no `connectClaude` block and no live client, the panel behaves
  exactly as before (paste behind Advanced), and the runtime auth path is unchanged.
