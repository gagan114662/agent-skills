# ADR-1510: Fail the boot, not the buyer — a startup preflight for billing mode/key consistency

- **Status:** Accepted (flag defaults OFF; the owner opts in on the production deployment)
- **Date:** 2026-07-01
- **Context issue:** [#1510](https://github.com/gagan114662/agent-skills/issues/1510) (ipop.ai: checkout
  is completely broken on all plans — revenue-blocking)
- **Builds on:** [ADR-0421](0421-go-live-billing-mode.md) (`BILLING_MODE` test/live separation + the
  fail-closed key guard), [ADR-0043](0043-stripe-revenue-rails.md) (inbound-only `BillingProvider` seam),
  [ADR-0125](0125-pricing-plans.md) (plan catalog + workspace-scoped checkout)

## Context

Every plan CTA on `/pricing` → `/signup?plan=X&billing=month` showed an "Opening checkout" spinner and,
after ~5s, failed with *"Checkout did not open… the team needs to fix the billing handoff."* The browser
network log showed **zero** requests to any billing/Stripe endpoint completing successfully — no plan could
be purchased on any tier. This was a total, silent revenue outage.

### Root cause

Production had a **real `sk_live_…` key present but `BILLING_MODE` unset**. `loadEnv` parses an unset
`BILLING_MODE` as `test` (fail-safe default, ADR-0421). ADR-0421 also added a fail-closed guard —
`assertKeyMatchesMode` — that refuses to run when the key's prefix mode contradicts the declared mode. But
that guard fired **only per-request, inside the Stripe adapter's `loadClient`** (`billing/stripe-provider.ts`).
So:

1. Boot succeeded — the startup preflight (`assertBillingProviderCredentials`) only checked that a key
   *existed*, never that its mode *matched*.
2. Every `POST /workspaces/:wid/billing/checkout` threw `BillingModeMismatchError` inside the adapter, which
   the manager wrapped into `BillingProviderError` → the route mapped it to a generic **502**.
3. The SPA turned that 502 into the opaque "the team needs to fix the billing handoff" message.

The mismatch reasoning was correct (fail closed — never charge with the wrong-mode key). The defect was
**latency of detection**: the misconfiguration surfaced one buyer at a time as an opaque 502, with no
boot-time or health signal, so it slipped into production and stayed there until a human manually QA'd the
funnel. Per the [#200 premortem](0200-premortem-panel.md): §3 (verification must touch reality — the check
must run where money actually moves) and §4 (money is IRREVERSIBLE — use a pre-commitment constraint, detect
fast, fail closed), a request-time-only guard on the revenue path is the wrong altitude.

> The incident itself was resolved in production config (owner set `fly secrets set BILLING_MODE=live`,
> verified an authenticated checkout returned HTTP 201 with a Stripe hosted URL). This ADR is the **code**
> hardening so the same misconfiguration can never again boot silently and cost revenue.

## Decision

Add a **strict startup billing preflight** that detects a mode/key mismatch at boot and fails loudly with an
actionable message, **behind a flag that defaults OFF**.

1. **A pure classifier — `diagnoseBillingConfig` (`billing/mode.ts`).** SDK-free, reasons over prefixes only,
   never the key value. Returns `ok` | `missing_key` | `mode_key_mismatch`:
   - `none` provider → always `ok` (it can never charge).
   - `stripe` + no key → `missing_key` (the pre-existing credential guard).
   - `stripe` + a mode-bearing key whose mode contradicts `BILLING_MODE` → `mode_key_mismatch` (the #1510
     case, and its inverse: a test key in live mode).
   - `stripe` + an unclassifiable/opaque key → `ok` (Stripe rejects a bad key itself; we never manufacture a
     false-positive boot failure).

2. **The startup preflight consumes it — `assertBillingProviderCredentials` (`billing/factory.ts`).** Already
   on the boot path (`createBillingProvider` calls it). It now classifies the config and, when
   `env.preflightStrict` is on and the diagnosis is `mode_key_mismatch`, calls ADR-0421's
   `assertKeyMatchesMode` to throw `BillingModeMismatchError` — the exact same actionable message
   ("BILLING_MODE=test but the supplied Stripe key is a live-mode key… Set a test-mode key, or change
   BILLING_MODE"), now at **boot** instead of per checkout.

3. **A flag, default OFF — `BILLING_PREFLIGHT_STRICT` (`env.ts`, `BillingEnv.preflightStrict`).** Only the
   exact strings `true`/`1` enable it. Default `false`: existing deploys are **byte-for-byte unchanged** —
   boot behaves exactly as before, and the request-time guard still fails closed. The owner opts in on the
   production (owner) deployment, where a loud boot failure is the desired signal.

### Why a loud boot failure (not auto-inference)?

We deliberately do **not** infer live mode from a live key and quietly start charging — that is precisely the
foot-gun ADR-0421 rejected (§4: going live is a deliberate, owner-set intent, never a side effect of which
key landed). A boot failure is the *strongest* fast-detection signal: the machine never reaches `/readyz`,
the deploy version-advance gate (ADR-0292) stays red, the release rolls back, and the operator is paged —
instead of customers silently hitting 502s. It is reversible (fix the env var and redeploy) and touches the
real money path (§3).

### Why owner-opt-in and not on by default?

A boot gate that can halt startup is itself a blast radius. Defaulting it OFF keeps the change additive and
non-regressive for every existing environment; the owner turns it on for the revenue-critical production
deployment once, as a deliberate posture choice — mirroring how every new capability in this repo ships
default-OFF, owner-workspace-first. There is no per-workspace dimension at process boot, so "owner-workspace-
first" here means: opt-in config the owner sets on the owner/production deployment, documented, not implicit.

## Alternatives considered

- **Map the mismatch to a clearer HTTP status/message at the checkout route.** Helps diagnosis but still
  surfaces one buyer at a time and changes a public error contract (test churn, still post-hoc). Rejected as
  the primary fix; the boot preflight is strictly earlier and louder.
- **Expose the diagnosis on `/readyz` or the billing-status surface without failing boot.** A reasonable
  softer follow-up (a "billing misconfigured" health field). Deferred — it widens the health contract and is
  weaker than fail-fast for a revenue-critical misconfig. Noted as a future option.

## Safety invariants (inherited + added)

- **Inbound money only** — the seam still has no refund/payout/transfer method (unchanged).
- **Fail-safe default** — `none` provider + `test` mode + `preflightStrict` OFF out of the box; CI/demo never
  spend and never gate boot.
- **Fail-closed on mismatch** — now at boot (opt-in) *and* per-request (always), a wrong-mode key refuses the
  charge path.
- **No secrets in logs or errors** — the classifier and guard reason over prefixes only; the key value is
  never read into, logged by, or thrown from the preflight.
- **No autonomous money move** — the preflight only *refuses to start*; it never enables live charging.
  Payouts/refunds remain #13 approval-gated (unchanged).

## Consequences

- The #1510 class of outage (a mode/key mismatch on the revenue path) is caught at boot the moment the owner
  enables the flag, rather than by a customer hitting checkout.
- `BillingEnv` gains an **optional** `preflightStrict` field — existing `BillingEnv` literals compile
  unchanged (no forced update, unlike ADR-0421's `mode`).
- Full unit coverage: the pure classifier (all six branches), the startup preflight (flag OFF = unchanged,
  flag ON = fails on both mismatch directions, passes on match/opaque/no-key, never leaks the key), and the
  env parsing (default OFF, `true`/`1` only).
