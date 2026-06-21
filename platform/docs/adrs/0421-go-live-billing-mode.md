# ADR-0421: Go-live billing path — `BILLING_MODE` test/live separation + a fail-closed key guard

- **Status:** Accepted (owner flips the live keys — see "What stays manual")
- **Date:** 2026-06-21
- **Context issue:** [#481](https://github.com/gagan114662/agent-skills/issues/481) (go-live billing path —
  Stripe is in test mode)
- **Builds on:** [ADR-0043](0043-stripe-revenue-rails.md) (the inbound-only `BillingProvider` seam, lazy
  Stripe SDK, per-tenant `BillingSecretsResolver` + redaction, signed webhooks), [ADR-0125](0125-pricing-plans.md)
  (the plan catalog + workspace-scoped checkout + activation)

## Context

The revenue rails are already wired end-to-end: checkout (#125), a signature-verified webhook that
activates a plan and records inbound revenue (#43/#98), the plan catalog, and the inbound-only safety rail.
But there was **no test/live separation**. `BILLING_PROVIDER=stripe` ran with whatever `STRIPE_SECRET_KEY`
was present — a `sk_test_…` or a `sk_live_…` key, with no guardrail — and the Settings → Billing panel
**hardcoded** a "Test mode — no live charges yet" banner regardless of reality. So "going live" was an
unverifiable, foot-gun-prone flip: a test key in production silently takes **zero** real money, and a live
key in staging silently charges **real cards**.

## Decision

Add an explicit **mode dimension** orthogonal to provider selection, plus a guard that fails closed on a
mismatch, plus a read surface so the UI tells the truth.

1. **`BILLING_MODE=test|live` (default `test`).** Provider chooses the backend; mode declares intent. Only
   the exact string `live` flips it — anything else stays `test` (fail safe). Parsed in `env.ts` into
   `BillingEnv.mode`.

2. **A pure, SDK-free guard — `billing/mode.ts`.** `stripeKeyMode(key)` infers `test|live|unknown` from the
   Stripe key prefix (`sk_/rk_/pk_` × `_live_/_test_`). `assertKeyMatchesMode(mode, key)` **throws
   `BillingModeMismatchError`** when the declared mode contradicts the supplied key, and is a no-op for an
   unclassifiable key (Stripe itself rejects a bad key; we don't manufacture false positives). The key
   value is **never** logged or interpolated into the error. This sits beside `safety.ts`: that rail stops
   money moving *out*; this one stops the *wrong* money moving *in*.

3. **The Stripe adapter carries the mode and fails closed before any network.** `StripeBillingProvider`
   takes the declared mode and asserts the key matches **before** the lazy SDK import — so a misconfigured
   env can never reach Stripe. The factory threads `env.mode` in.

4. **A read-only status surface.** `billingStatus(provider, mode)` derives `{ provider, mode, live }` where
   `live` is true **only** for `stripe` + `live` (the no-network `none` provider can never charge).
   Exposed at `GET /workspaces/:wid/billing/status` (auth + workspace-scoped, IDOR-safe, no secrets). The
   Settings → Billing panel fetches it and renders the **real** state — "Live — real payments are on" vs
   "Test mode" — instead of a fixed banner.

### Why not infer mode from the key alone?

The key prefix *can* be read, but a single source of truth that the owner sets **deliberately** is safer:
the explicit `BILLING_MODE` is the intent, and the key guard catches the case where the two disagree. A
key-only inference would happily go live the instant a live key landed in any env — the opposite of a
deliberate flip.

## What stays manual (the owner-gated go-live flip)

The agent **never** sets live key material or flips the switch. The owner does, once, following
[`docs/guides/billing-go-live.md`](../guides/billing-go-live.md):

```
fly secrets set STRIPE_SECRET_KEY=sk_live_…    --app reload-api
fly secrets set STRIPE_WEBHOOK_SECRET=whsec_…  --app reload-api
fly secrets set BILLING_PROVIDER=stripe         --app reload-api
fly secrets set BILLING_MODE=live               --app reload-api
# then mint the real products/prices once, and verify the first live payment.
```

The repo contains **zero** key material; `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` are **names** on the
#25 secrets path (values live only in Fly secrets). Payouts/refunds remain a #13 approval-gated,
recorded-only action in the Stripe dashboard (unchanged from #98).

## Safety invariants (inherited, unchanged)

- **Outbound money is structurally impossible** — the seam has no refund/payout/transfer method.
- **Fail-safe default** — `none` provider + `test` mode out of the box; CI and the demo never spend.
- **Fail-closed on mismatch** — a test key in live mode (or vice-versa) refuses to start the charge path.
- **No secrets in logs or errors** — the mode guard reasons over prefixes only and never echoes the key.

## Consequences

- Going live is now a deliberate, auditable, **reversible** config flip with a guardrail, not an implicit
  side effect of which key happened to be set.
- A new `BillingEnv.mode` field — every `BillingEnv` literal must set it (the loader + tests updated).
- The UI is honest: the "Live" banner appears **iff** real money is actually on.
