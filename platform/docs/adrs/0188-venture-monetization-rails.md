# ADR-0188: Venture monetization rails — every venture can charge money, the owner holds the keys

- Status: Accepted
- Issue: #188
- Date: 2026-06-14
- Premortem: #200 (FM#2 external receipts only, FM#4 money is irreversible, FM#5 attention is budgeted)

## Context

ipop can bill its own customers (#98/#125), but the ventures the fleet runs could not charge theirs. A
venture that cannot collect revenue is a hobby. We need per-venture monetization that is real (a venture
mints live Stripe products/prices/payment links and collects money) but never lets an autonomous agent
move money on the owner's behalf, and never touches ipop's own Stripe account.

The premortem (#200) is non-negotiable here because money is the canonical IRREVERSIBLE action:

- **FM#4 (money is irreversible)**: creating/activating anything that lets money move must be a
  pre-committed, human-gated decision with the exact amount in front of the owner — never post-hoc review.
- **FM#2 (self-reported metrics are fiction)**: revenue metrics may come ONLY from externally-verified
  receipts (signature-verified Stripe webhooks). Projections are forecasts, labeled UNVERIFIED.

## Decision

A new default-OFF `monetization` module that reuses the existing rails rather than rebuilding them.

### 1. Per-venture Stripe key — the #192 vault, never ipop's (AC1)

A venture's Stripe credentials live in the #192 write-only `external_credentials` vault, keyed
`stripe:<ventureIdeaId>` (a `VentureStripeResolver` over `setServiceCredentials`/`resolveServiceSecrets`).
This is a **separate Stripe account per venture**. The billing surface's `BillingSecretsResolver` (ipop's
env `STRIPE_SECRET_KEY`) is never consulted for a venture, and the venture key is never injected into agent
runtimes. Monetization is **default OFF per venture** until the owner connects that venture's account
(`connectVentureStripe`, human-once).

### 2. Drafts are free; the money boundary is the #13 queue (AC1, AC2)

- **Draft** (`monetization_plans.status = 'draft'`): the fleet drafts a product + price + payment-link
  intent. Reversible, no Stripe call, no gate.
- **Activate / re-price / payout settings** = MONEY decisions. Two new sensitive-by-default action kinds,
  `monetization.activate_price` and `monetization.payout_settings`, evaluated against the #13
  `approval_policies` (never route-submittable, like `venture.bootstrap`). The request carries the EXACT
  amount (drives the spend gate AND renders on the #170/#183 Slack one-tap card via
  `summarizeActivation` → "$25.00/month", or a before→after on a re-price). Their executors are
  **recorded-only** (`{recorded:true, executed:false}`), exactly like `billing.refund`/`finance.disbursement`.
- After the owner approves, the `MonetizationEngine` tick (`activatePending`) mints the REAL hosted
  payment link through the inbound-only #98 `BillingProvider` using the venture's OWN key. Minting only
  ENABLES collection (the seam has no payout/refund/transfer method), so it stays inside the money-safety
  rail even though it runs post-approval — a live link is created only after the human go, never autonomously.

### 3. Pricing experiments (AC3)

`proposeExperiment` stores a price test with a `projectExperimentImpact` projection (`estimateLabel:
"UNVERIFIED"`, persisted in `projected_delta_cents` + `baseline_revenue_cents`). Activation
(`requestExperimentActivation`) re-prices the target plan and requires the owner's yes (the same
`monetization.activate_price` decision). `concludeExperiment` records the outcome from
**externally-verified** revenue only (`monetization_revenue`), so what lands on the scorecard is a
receipt-backed fact, with the original forecast retained for the forecast-vs-reality (taste-gap) signal.

### 4. Revenue attribution (AC4)

Each venture has its own Stripe account → its own webhook. `ingestVentureWebhook` verifies the delivery's
signature with the venture's own webhook secret (reusing `verifyWebhookSignature`), then records a
verified, venture-attributed receipt in `monetization_revenue` (deduped on `(workspace_id,
provider_event_id)`, the raw body redacted). The #194 finance ledger's revenue reader (`finance/default.ts`)
UNIONs these venture receipts alongside the workspace-level `revenue_events`, so per-venture revenue posts
as a verified ledger credit attributed to its venture and surfaces on the #173 weekly per-venture P&L.

We deliberately do **not** write revenue into `tenant_usage`: that table is the governed cost/usage surface
(and writing it would trip the #155 colocation gate). Revenue is recorded as verified finance ledger
credits — the accounting surface that already sits alongside `tenant_usage` cost in the P&L.

### 5. Refunds (AC5)

Already handled: the #190 support flow routes a refund to the money queue as a recorded-only
`billing.refund`, never auto-executed. Monetization adds nothing here beyond honoring that path.

## Schema & safety

- Migration `0188_venture_monetization.sql` (+ `.down.sql`), numbered by issue (ADR-0099). Tables use the
  **non-governed `monetization_` prefix** so the colocation CI gate passes (FK references to `venture_ideas`
  are fine; only `CREATE/ALTER` of a `venture_*`-named table trips it — same reasoning as #194's `finance_*`).
- Config block `monetization` in all five sites (schema + ResolvedConfig + CONFIG_DEFAULTS + layers
  mergeSettings + mergeLayers). **Default OFF**, owner-workspace-first.
- The engine timer (`MONETIZATION_INTERVAL_MS`, default 0 = off) is wired in `index.ts`; the service +
  engine are decorated on the app in `app.ts` (injectable for tests).

## Consequences

- The whole capability is inert until a deployment sets `monetization.enabled` AND a venture connects its
  own Stripe account — three independent OFF switches in front of any money.
- No autonomous money movement is possible: the provider seam is inbound-only, money actions are
  recorded-only, and live links are minted only after an owner approval that shows the exact amount.
- The finance reader change is additive and null-safe: with monetization off, the venture receipt source is
  empty and finance behavior is byte-for-byte unchanged.

## Alternatives considered

- **Mint the live link directly in the activation executor.** Rejected: it would couple `approvals/runtime`
  to billing/monetization and run a network call inside the #13 execute path. The recorded-only executor +
  engine-driven mint keeps the executor pure and consistent with every other money action.
- **Add `venture_idea_id` to `revenue_events`.** Rejected: it would mutate #98's core table and risk
  conflating ipop revenue with venture revenue. A dedicated `monetization_revenue` table keeps the two
  disjoint (separate Stripe accounts) and the attribution clean.
