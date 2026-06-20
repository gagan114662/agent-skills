# ADR-0402: Attribution through checkout — carry the #386 tracking ref through Stripe to revenue_events

- **Status:** Accepted (slice 3 of #386 — the ref now rides through Stripe metadata to the receipt)
- **Date:** 2026-06-19
- **Context issue:** [#386](https://github.com/gagan114662/agent-skills/issues/386) — the attributed-revenue
  ledger. Slice 1 ([ADR-0386](0386-attributed-revenue-ledger.md)) shipped the pure causal-credit core +
  the `attribution_exposures` schema; slice 2 wired live exposure capture. But the join was inert: every
  Stripe receipt mapped to `trackingRef: null`, so **every real payment landed in `unattributed`**. The
  fleet could not prove which artifact/lead earned which dollar — the keystone gap the leads-centre gap
  analysis calls GAP 2 / "slice 3".

## Context

The causal chain is `fleet artifact → exposure → signup → payment`, joined by a stable tracking ref minted
in `attribution/tracking.ts`. Two of the three legs already persisted the ref:

- **exposure** — `attribution_exposures.tracking_ref` (slice 1), and
- **payment** — a signature-verified Stripe receipt in `revenue_events` (#98).

The receipt simply had **no ref column**, and the projection (`attribution/service.ts`) hard-coded
`trackingRef: null`. So even when an exposure existed, the happened-before join (`chain.attributeRevenue`)
had nothing to match on.

## Decision

Carry the ref the rest of the way, read-only — no money path, no new action:

1. **Schema (migration 0402, additive).** `revenue_events.tracking_ref text` — nullable. Existing rows ⇒
   NULL ⇒ still `unattributed` (honest). Numbered 0402 by a FREE prefix per [ADR-0099](0099-migration-numbering.md)
   (0400/0401 are claimed on sibling workspaces).
2. **Webhook extraction.** `ingestWebhook` reads `metadata.trackingRef` and persists it via
   `sanitizeTrackingRef` — the value comes off an external webhook so it is treated as untrusted DATA
   ([#200 §6](0200-premortem-panel.md)): it must be a single-line, prefix-`ipop_`, ref-shaped string within
   length bounds, else it stores `null` rather than poisoning the join.
3. **Checkout metadata.** Both Stripe paths stamp a (sanitized) `trackingRef` into checkout metadata when
   one is supplied: the session payment-link (`BillingManager.createPaymentLink`) and the plan checkout
   (`PlanBillingService.createCheckout`). So a real Stripe payment now round-trips its ref to the webhook.
4. **Attribution read.** The ref is threaded through the `RevenueEventReader` seam: the finance
   `RevenueReceipt` and the attribution `AttributionRevenueReceipt` gain an optional `trackingRef`; the
   shared `dbRevenueReader` selects the new column. `projectAttributedRevenue` reads the real ref instead
   of `null`, so a receipt whose ref matches a recorded exposure now attributes by happened-before (L2;
   every credited dollar still backed by an external receipt, L1).

## Consequences

- A real payment carrying a ref of an exposed artifact now **attributes** to that artifact/lead. The
  north-star "which work earned a dollar" question becomes answerable for ref-carrying payments.
- Existing rows and any no-ref payment stay **honestly `unattributed`** — never fabricated onto an artifact.
- **No money path, no new action.** This is metadata + a read. Minting / charging is unchanged; the #13
  approval queue is untouched.
- **Follow-up (gap 4):** the auth'd `/billing/checkout` route plumbs the `trackingRef` FIELD through, but
  does not yet recover a ref off the inbound landing URL (`recoverTrackingRef` is live but unwired there).
  Wiring the landing→checkout ref source is the gap-4 follow-up; until then a ref only flows when a caller
  supplies it explicitly (e.g. an outreach-minted payment link from GAP 3).

## Alternatives considered

- *Store the ref only in `raw`* — rejected: `raw` is redacted free-form JSON; a typed nullable column is
  queryable, indexable later, and unambiguous for the reader seam.
- *A separate ref-mapping table* — rejected as over-built; the ref belongs on the receipt it describes, and
  an additive nullable column keeps the migration trivial and the no-ref default behavior unchanged.
