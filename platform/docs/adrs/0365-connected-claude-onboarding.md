# ADR-0365: Connected-Claude onboarding for the owner workspace

- **Status:** Accepted (build + PR only; nothing enabled in production)
- **Date:** 2026-06-18
- **Context issue:** [#365](https://github.com/gagan114662/agent-skills/issues/365) — part of epic
  [#359](https://github.com/gagan114662/agent-skills/issues/359). The fleet runs **subscription-token-only,
  per tenant** (`platform/fly.toml`, [ADR-0068]): a workspace runs real `claude-code` sessions only once it
  connects its OWN `CLAUDE_CODE_OAUTH_TOKEN` into the #68 vault, and there is **no `ANTHROPIC_API_KEY`
  fallback** ([#246]). Until the owner workspace is connected, every @mention gets the friendly "reconnect
  your Claude" reply (`marketing/connect-prompt.ts`) and the board stays empty — so a connected owner
  workspace is the foundational dependency for the rest of the epic. This work makes that onboarding path
  **solid and obvious** and adds an honest **connection-health signal**.
- **Builds on:** [ADR-0068] (the per-tenant vault + subscription-first gate), [ADR-0262] (Connect Claude
  without a CLI — the one-click scaffold, default-OFF, owner-first), [#246] (subscription-only launch
  preflight), [ADR-0243] (connecting is consent, not money → no #13 gate), [ADR-0352] (the web owner-first
  flag pattern this mirrors).

## Decision

Treat #365 as **enablement + verification + polish** on top of the already-shipped #262/#68 seams — reusing
them rather than inventing new mechanism — across three honest, default-OFF, owner-workspace-first slices.

### (a) The manual paste path stays the robust, always-available front door

The manual paste path (Settings → Connect Claude → Advanced → paste a `claude setup-token` →
`PUT /me/agent-credentials` → sealed into the #68 vault) is unconditional and always works, regardless of
any flag. The first-run empty-state (`ConsoleEmptyState`) already routes an unconnected owner straight to it
(`onConnect` → Settings). This PR keeps that path intact and adds a persistent header surface (slice c) for
the case the empty-state misses: a seeded-but-unconnected board.

### (b) The #262 one-click scaffold is finished as far as it can go — honestly

The pure brain, routes, HMAC state, injection validators, provider seam, and config block from #262 are
complete. What remains is an **owner step, not code we can fake**: a live Anthropic OAuth client
(`CLAUDE_OAUTH_*`) must be registered and its env set. Per [#200 §3] we never fabricate a "connected" we
didn't verify — so with `connectClaude.enabled = true` but no live client, the offer stays an honest
`coming_soon` (`decideClaudeConnectOffer`) and the paste path remains. The exact owner enablement sequence
is documented in [`docs/runbooks/connect-claude-owner.md`](../runbooks/connect-claude-owner.md). **This PR
wires no client and flips no production flag.**

### (c) A connection-health signal — connected / not connected / token expired

A pure, total, fail-closed derivation (`auth/claude-connect-health.ts`,
`deriveClaudeConnectionHealth`) reports a tri-state from facts the vault already holds — **no live call, no
token access**:

- `not_connected` — no credential row. The fleet cannot run.
- `connected` — a credential is present and nothing has observed it failing since the last (re)connect.
- `expired` — a credential is present but a real agent launch **observed** it as unusable (a
  removed/blanked/undecryptable stored token) **after** the last (re)connect. Owner-facing: "reconnect".

The `expired` signal is sourced from an **observation, never a guess**: an additive, nullable
`last_auth_failure_at` column (migration 0365) is stamped by `recordClaudeAuthFailure` at the ONE structural
place a launch can see auth is unusable — the @mention auth gate's `onAuthUnavailable` hook (best-effort,
side-effect-only; it **never** changes the gate's launch/no-launch decision). The recorder is a row-scoped
UPDATE, so it is a no-op for a never-connected workspace (it can never fabricate a credential) and only flips
a CONNECTED workspace to `expired`. A (re)connect clears the marker (last write wins), so the state is fully
reversible and never a sticky false alarm.

Detecting a token that still **decrypts** but has been revoked upstream would require a live validation call;
we deliberately do not make one (the #365 hard boundary forbids handling the token, and #200 §3 forbids
faking validity). That detection is the owner-gated verification step — a real owner @mention — at which
point the same gate observes the failure and the signal flips. The derivation already supports the state; we
built "the flow + the place for it," not a fabricated check.

The signal is exposed read-only at `GET /me/claude/health` (`/me/*`-scoped, never a secret) and surfaced two
ways, both default-OFF + owner-workspace-first:

- A header **chip** (`ConnectHealthChip`) gated by `connect-health-flag.ts`
  (`VITE_RELOAD_CONNECT_HEALTH_UI` + `…_OWNER_WORKSPACE_ID`, fail-closed, mirrors the #352 coordination
  flag). Connected = a quiet confirmation; not-connected/expired = the button to Connect Claude.
- The **Connect-Claude panel** consumes health so an `expired` credential shows a "reconnect" warning
  instead of a misleading "✅ Connected" (a row still exists, so without this it would lie).

## Honoring #200 (premortem)

- **§3 production-grounded:** `expired` is reported only from a recorded observation; a present credential
  with no observed failure is honestly `connected`, never a faked "valid". No live validation call is made.
- **§4 reversibility:** connecting/disconnecting/reconnecting is reversible; a reconnect clears the failure
  marker. Connecting is consent, not money — no #13 gate ([ADR-0243]); #13 is untouched.
- **§6 injection defense:** the health derivation reads timestamps + a boolean only (no string content to
  steer). The #262 callback `code`/`state` validators (`isValidAuthCode`, HMAC state) are unchanged.
- **Owner-first / fail-closed:** every new surface defaults OFF and shows only for the named owner workspace
  (named-nobody = nobody). Customer tenants are byte-for-byte unchanged; prod (which sets no new env) is
  byte-for-byte the board it is today.

## Consequences

- The owner has an obvious, robust path to connect (paste today; one-click once they wire `CLAUDE_OAUTH_*`)
  and a glanceable connection-health signal. **The one owner action that unlocks real agent runs is
  connecting their Claude token** — everything else here is the place that makes that action obvious and its
  state visible.
- Additive + reversible: migration 0365 adds one nullable column; with no new env the runtime auth path
  (#246) and the console are unchanged.
- The live OAuth client (`CLAUDE_OAUTH_*`) and a live token-expiry probe remain explicit owner/follow-up
  steps; the seam, validators, storage, and the `expired` derivation are already in place so each is
  incremental.

[ADR-0068]: 0068-subscription-first-agent-auth.md
[ADR-0262]: 0262-connect-claude-without-cli.md
[ADR-0243]: 0243-money-only-approval.md
[ADR-0352]: 0352-agent-coordination-surface.md
[#246]: https://github.com/gagan114662/agent-skills/issues/246
[#200 §3]: https://github.com/gagan114662/agent-skills/issues/200
