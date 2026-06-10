# ADR-0043: Stripe revenue rails — integrate Stripe behind a `BillingProvider` adapter, inbound only

- **Status:** Accepted (Gagan approves defaults-and-go; **video gate waived by the owner** — issue #98)
- **Date:** 2026-06-10
- **Context issue:** [#98](https://github.com/gagan114662/agent-skills/issues/98) (revenue rails — the
  payment counterpart to #73 deploy, feeding the #96 venture loop)
- **Builds on:** [ADR-0025](0025-cloud-execution.md) (the `*Provider` adapter seam, lazy SDK, per-tenant
  `SecretsResolver` + value redaction), [ADR-0041](0041-deploy-to-live-url.md) (a manager **separate** from
  `SessionManager`, a persisted immutable record, channel-bus events, the off-platform egress gate, the
  trusted-config trust boundary), [ADR-0013](0013-approval-gates.md) (sensitive actions gated for a human),
  [ADR-0040](0040-cloud-scale.md) (the per-tenant usage surface)
- **Coordinates with:** [#96](https://github.com/gagan114662/agent-skills/issues/96) (the venture
  scorecard) — this work is **independent + additive**: it writes its own `revenue_evidence` table that #96
  reads; it adds **no** dependency on #96's tables, so the two branches merge without contention.

## ⚠️ Decision first — build vs. integrate

**Decision: integrate Stripe behind a `BillingProvider` adapter; do NOT build a payments processor.** This
issue is scoped to *the revenue capability + the adapter*, not to becoming a PSP. Building payments natively
(a ledger, reconciliation, dispute/chargeback handling, KYC, PCI scope) is a regulated, multi-quarter
undertaking we would then own forever; an integration adapter ships the user value — "a venture charges real
money in" — in one PR with **zero payments infrastructure to operate**. Stripe already gives us hosted
checkout, payment links, signed webhooks, and a dashboard for the parts a human must own (payouts). The seam
means a second provider (Paddle / Lemon Squeezy) is a new adapter, not a rewrite — so the choice is
reversible. This is the exact trade ADR-0025 made for execution and ADR-0041 for deployment, reused here for
revenue.

**Chosen first provider: Stripe** via the official `stripe` npm SDK, loaded behind a **lazy dynamic import**
so it stays an optional dependency CI never touches (same discipline as `VercelSandboxProvider` /
`VercelDeployProvider`). The **default** provider is a no-network `NoneBillingProvider` that exercises the
whole surface, so dev / CI / the demo never make a network call and never spend.

## Context

The platform can build (#50/#25) and deploy (#73) an app to a live URL, and #96 will gate work on
YC-fundability — but there is **no payment rail**: zero Stripe code in the repo. "An autonomous company that
cannot charge is a demo." We need real money **in** (proof of willingness-to-pay, the strongest venture
signal) while keeping a hard safety rail around money **out** (an autonomous agent must never move funds out
of the owner's Stripe account).

## Decisions

1. **A `BillingProvider` adapter seam, default = a no-network `NoneBillingProvider`.** Mirroring the
   `DeployProvider` seam (ADR-0041), `billing/provider.ts` defines a narrow **inbound-only** interface
   (`createProductPrice`, `createPaymentLink`); `billing/none-provider.ts` is the **default** (deterministic
   `https://pay.none.reload.test/<slug>` link + synthetic ids, records calls, echoes the resolved secret in a
   synthetic note so the redaction test is real — zero network); `billing/stripe-provider.ts` is the real
   adapter behind a **lazy `await import("stripe")`** gated by `BILLING_PROVIDER=stripe`.
   `createBillingProvider(env)` selects, exactly like `createDeployProvider`. Tests inject a fake provider —
   **zero network, zero spend**.

2. **Inbound money only — enforced structurally, not by convention.** The `BillingProvider` interface has
   **no** `refund` / `payout` / `transfer` method: the seam *cannot* express outbound money. The
   `BillingManager` has no path that moves money out. A pure `assertInboundOnly` guard
   (`billing/safety.ts`) fails closed on the `OUTBOUND_MONEY_ACTIONS` set. This is the central safety
   decision: an agent operating the manager can only ever *collect*, never *disburse*.

3. **Outbound money is a #13 sensitive action, recorded-only in v1 — payouts stay manual in Stripe.**
   `billing.refund` / `billing.payout` / `billing.transfer` are added to the #13 `DEFAULT_SENSITIVE_ACTIONS`
   (gated when no workspace rule matches — sensitive by default, like `external.send`). `billing.refund` is
   wired as a **recorded-only** approval executor (the `external.send` pattern): even after a human approves,
   v1 performs **no** Stripe call — it records the intent. Payouts/transfers are not wired at all; they stay
   **manual in the Stripe dashboard**. Wiring a real `stripe.refunds.create` behind the gate is a deliberate
   future ADR, never an autonomous call.

4. **A separate `BillingManager`, NOT the `SessionManager`.** Same argument as ADR-0041 §2: a billing flow
   is a durable, off-platform, credential-bearing job whose record must survive a restart. `billing/manager.ts`
   is standalone, reuses the provisioner-free secrets + redaction + egress + channel-post primitives, and
   **persists** to dedicated tables. Keeping it off the run path keeps the blast radius off the
   safety-critical orchestrator.

5. **Signature-verified, replay-resistant, deduped webhooks — verification is pure and SDK-free.**
   `billing/webhook.ts` implements Stripe's signature scheme (`t=<ts>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>`)
   with `node:crypto`: a constant-time compare plus a tolerance-window check on the timestamp (replay
   protection). It is a **pure** function both providers and the manager call, so verification is identical
   regardless of backend and needs no network — which makes the signature / replay / dedupe tests real and
   hermetic. Idempotency is enforced a second time at the DB via a **unique `(workspace_id, provider_event_id)`**
   index, so even a duplicate *valid* delivery yields at most one `revenue_events` row. The receiver reads the
   **raw** body via a content-type parser **encapsulated to the single webhook route** (Fastify per-plugin
   scoping) so the rest of the app keeps normal JSON parsing.

6. **Secrets per tenant, never logged; redaction applies.** `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
   live ONLY on the #25 `SecretsResolver`/`AGENT_SECRETS` path keyed by workspace; config carries only the
   var **names**. Every provider error and the stored webhook `raw` payload pass through `makeRedactor(secrets)`
   before persistence/streaming, so a key value can never appear in a `revenue_events.raw` column, a
   `billing_status` event, a `payment_links` row, the channel message, or a log line. (The #25 guarantee,
   reused.)

7. **Revenue feeds the venture loop additively.** A successful-payment webhook writes a `revenue_evidence`
   (`kind = 'willingness_to_pay'`, `source = 'revenue'`) row referencing the `revenue_events` row. This is a
   **new, independent** table this PR owns; #96's scorecard reads it. Neither branch depends on the other's
   schema, so they merge cleanly (the explicit #96 coordination ask). Revenue per venture is surfaced at
   `GET /workspaces/:wid/billing/revenue`, the #71 dashboard pattern.

8. **Off-platform egress gate + trusted config.** Creating a Stripe object is off-platform egress, so
   `createPaymentLink` calls `egressAllowed(cfg)` first and refuses under `dataPrivacyMode` (the #58 gate #73
   honors). Provider selection, currency, and secret-var names come from **trusted** layered config
   (repo/managed scope), never the request body — the #73/#27 trust boundary; the request carries only a
   bounded product name + amount.

## Alternatives considered

- **Build payments in-house.** Rejected (decision §0): regulated, multi-quarter, PCI scope, and it would
  make us a PSP — outside "Slack for AI agents".
- **Let the manager perform refunds behind the approval gate in v1.** Rejected (§3): the owner's hard rail is
  that an autonomous system must never move money out; recorded-only + manual-dashboard payouts is the safe
  default. Real outbound execution is a separate, explicit ADR.
- **Verify webhooks with `stripe.webhooks.constructEvent` (SDK).** Rejected for the *core* path (§5): it
  would pull the optional SDK into the hot path and CI. We implement the documented scheme purely with
  `node:crypto` (the SDK does the same HMAC); the `StripeProvider` may still use the SDK for *creating*
  objects, but verification stays pure and testable.
- **A single global webhook endpoint.** Rejected: multi-tenant secrets differ per workspace, so the receiver
  is workspace-scoped (`/billing/webhook/:wid`) and resolves that tenant's webhook secret.

## Consequences

- **Positive:** real revenue in one PR with zero payments infra; an autonomous company can prove
  willingness-to-pay with real money; a hard, structural safety rail around outbound money; dev/CI/demo make
  zero network calls; the venture loop (#96) gets the strongest possible signal additively; the seam keeps a
  second provider a drop-in.
- **Negative / accepted:** v1 cannot *execute* a refund/payout from the app (manual in Stripe) — intentional;
  the `stripe` SDK is a new optional dependency (lazy, never in CI); a real Stripe account + webhook endpoint
  configuration is required to exercise the live path (the none provider covers everything else).

## Compliance / how this is verified

Unit (no DB/network): pure signature verify + replay; provider factory selection; inbound-only guard +
policy gating + recorded-only executor; manager flows (link, webhook→event→evidence, dedupe, redaction,
egress, opt-in) over the none provider + in-memory store. Integration (real Postgres/Redis, none provider):
payment-link → channel post + deployment attach; signed webhook → deduped `revenue_events` + `revenue_evidence`
+ `💰` post; replay no-op; bad signature `400`; revenue dashboard totals; IDOR `404`. `pnpm -C platform
typecheck && lint && test` + integration green. Spec `docs/specs/98-stripe-revenue-rails.md`, migration
`0098_stripe_revenue_rails.sql` (+down), demo `scripts/demos/98-stripe-revenue-rails.sh`. PR links #98 with
`Closes #98`; **the owner has waived the video gate** for this issue.
