# ADR-0336: Connect capability tokens — scoped, short-lived, delegated agent credentials (extends ADR-0258)

- **Status:** Accepted (shipped in PR for #336)
- **Date:** 2026-06-18
- **Context issue:** [#336](https://github.com/gagan114662/agent-skills/issues/336) — apply the Vercel Ship 26
  "Connect" credential model to ipop's fleet. A long-lived credential is permanent access, and a human-scoped
  credential lets an agent do anything the user can. Connect issues **least-privilege, per-action, expiring**
  tokens instead.
- **Extends:** [ADR-0258](0258-connect-once-integrations.md) (the connect-once seam — descriptors, the HMAC
  state, the `ConnectProvider` adapter, `mapExchangeToSeal`, the connected-capability read side). This builds
  a token-mint path **on top of** that seam; it does not introduce a parallel credential system.
- **Builds on:** [ADR-0192](0192-external-account-onboarding.md) (the write-only encrypted credential vault —
  the raw secret stays sealed there, unread by the agent), [ADR-0013](0013-approval-gates.md) (the #13
  approval queue, reused as the audit trail), [ADR-0243](0243-money-only-approval.md) (minting is a
  CONSENT-class trace, not money, so it carries no money gate).

## Problem

After #258 a workspace connects an outside account once and the agents act through it. But the model still
assumed an agent holds the *connection's* standing credential for the life of the work — exactly the
long-lived, human-scoped credential the premortem warns against (#200 §4: an outward grant is not cheaply
reversible). If that credential or the agent process leaks, the blast radius is "everything the user can do,
forever."

## Decision

Agents request a **capability token per action** instead of holding a standing secret. A token is:

1. **Scoped** — to ONE connection + ONE capability + ONE verb (`read`/`write`). The authority comes *only*
   from the sealed #258 connection scopes (`token-mint.ts` intersects the request against
   `connectionGrant`); a capability outside the grant is refused (`scope_denied`).
2. **Short-lived** — an HMAC-signed claim with a TTL `exp` (default 5 min, clamped to a hard [30 s, 1 h]
   range). It self-expires; there is no standing token to leak.
3. **Delegated** — the claims carry the `user (member) → agent → service (connection)` chain, so every token
   is attributable end-to-end.
4. **Traceable** — every mint writes a recorded-only `capability.mint` row into the #13 `approval_requests`
   audit trail capturing that delegation chain.

The raw provider secret is **never** stored in or derived from the token — it stays sealed in the #192 vault.
The token is a bearer claim the seam mints off the existing grant, not the credential itself.

### Honoring the premortem (#200)

- **§3 production-grounded verification.** After minting, the `CapabilityTokenProvider.verify` seam reads BACK
  from the provider's real API to prove the token works. `verified` is recorded from that read-back, **never
  assumed**. The default `DryRunCapabilityTokenProvider` makes no network call and reports `verified:false`,
  so an unwired deployment labels a token honestly as "unverified" rather than faking success.
- **§4 irreversible actions stay pre-committed.** A `write` (send/post/spend) token is refused
  (`needs_approval`) unless the caller supplies an already-approved #13 `approvalRequestId`. The mint is never
  the gate for an outward mutation — the owner's pre-commitment must already exist. A `read` token (reversible)
  mints autonomously (still recorded).
- **§6 injection defense.** A token's `capability`/`verb`/scope come only from the signed claims minted off
  the connection grant. The verify provider's response is untrusted DATA whose return type
  (`{ verified, externalRef, detail }`) has **no scope field** — it can confirm or deny a token, never widen
  it. `normalizeVerification` re-derives the verdict from only those three fields and sanitizes the strings.

### Default OFF, owner-workspace-first, dry-run by default

The live mint ships behind a new `capabilityTokens` config block: `liveMintEnabled` default OFF,
`ownerWorkspaceOnly` default true (mirrors `connectOnce`/`skillopt`/`delivery`). Fail-closed:
`liveMintEnabled` without naming the owner lets nobody in. Env overrides
(`RELOAD_CAPABILITY_TOKENS_LIVE_MINT` / `RELOAD_CAPABILITY_TOKENS_OWNER_WORKSPACE_ID`) let the owner dogfood
on their own workspace first; a managed layer wins as the lock. No live verify provider is wired in this
slice, so even with the flag on, tokens read back as unverified until a per-department follow-up registers a
real provider behind the #192 vault.

### Idempotency

A mint request may carry an `idempotencyKey`; a repeat with the same key returns the SAME unexpired token (no
second mint, no second audit row). The production store is an in-memory TTL map keyed by (workspace, key) —
tokens are short-lived, so no migration is needed; an expired slot is evicted on read so a stale token can
never be reused.

## Consequences

- A leaked agent process holds, at most, a single-capability token that expires in minutes — not the user's
  standing credential. Blast radius is bounded and self-healing.
- The seam is one provider registration away from live verification + live minting, exactly like the #258
  per-department follow-ups; the interfaces (`CapabilityTokenProvider`, `connectionGrant`, the audit record)
  are already in place and owner-gated the whole way.
- No migration: config-resolved + the existing #192 vault + the #13 `approval_requests` audit trail + an
  in-memory idempotency map. Back-compat preserved — with `capabilityTokens` unset, nothing is ever minted.
- **Hard boundary (this PR):** no real provider account is connected and no live credential is handled. We
  build the mint path, the adapters, the mocks, and the tests; the live mint stays gated, default OFF,
  owner-workspace-first.
