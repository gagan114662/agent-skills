# ADR-0125: Pricing page + Stripe checkout — a thin plan layer on the merged #98 rails

- **Status:** Accepted (Gagan approves defaults-and-go; **video gate waived by the owner** — issue #125)
- **Date:** 2026-06-10
- **Context issue:** [#125](https://github.com/gagan114662/agent-skills/issues/125) (pricing page on
  ipop.ai wired to Stripe — the customer-facing front of the #98 revenue rails)
- **Builds on:** [ADR-0043](0043-stripe-revenue-rails.md) (the `BillingProvider` adapter seam, lazy SDK,
  no-network `NoneBillingProvider` default, signature-verified webhook ingest + dedupe, per-tenant
  `SecretsResolver` + value redaction, the `billing` config block + egress gate), the #122 ipop brand
  shell (`brand.ts`, the 4-tab `Workspace`), [ADR-0040](0040-cloud-scale.md) (`tenant_usage` + per-tenant
  caps), [ADR-0013](0013-approval-gates.md) (outbound money gated, recorded-only), [#9] (IDOR/RBAC).
- **Coordinates with:** [#96](https://github.com/gagan114662/agent-skills/issues/96) — unchanged: plan
  payments flow through the same #98 `revenue_evidence` the scorecard already reads. No new dependency.

## ⚠️ Decision first — build vs. integrate
**Reuse the merged #98 rails; add only a pricing/plan layer. Do not build a second billing path.** #98
already operates inbound checkout, signed webhooks, dedupe, redaction, the provider seam, and the secrets
path. Re-implementing any of that for a pricing page would duplicate the most safety-critical code in the
system. #125 is scoped to the three things #98 deliberately left to a later issue:

1. **A plan catalog** — what we sell, and how each plan maps to tenant caps.
2. **A workspace-scoped checkout** — #98's checkout is session-scoped (it attaches to a deployed app +
   channel); a "subscribe to Pro" click has no session, so it needs its own thin entry point.
3. **Plan activation on the webhook** — mark the workspace's plan and update its caps when money lands.

This is the same reuse-over-rebuild trade ADR-0043 made for the rails themselves.

## Decisions

### 1. The plan catalog is a pure module (`billing/plans.ts`)
Three plans (Starter/Pro/Agency) as a frozen array; `getPlan(key)` and `planCaps(plan)` are pure
functions. No DB, no I/O — unit-testable in isolation and shared as the single source of truth for both
the server (checkout amount, activation caps) and the web page (rendered cards). Caps map to existing
tenant dimensions: `agentSeats`, `monthlySessionBudgetCents` (→ `[scale].budgetCents` / `tenant_usage`
cost ceiling), `fleetSize`.

### 2. Checkout reuses the #98 provider seam, gated identically
A new `PlanBillingService.createCheckout` resolves the plan, **ensures a price** (find-or-create in the
registry), and calls `provider.createPaymentLink({ priceId, metadata: { workspaceId, planKey, kind:
"plan_checkout" } })` — the exact #98 seam, no new provider surface. It enforces the same opt-in (`billing`
config present) + egress (data-privacy) gate, so a misconfigured tenant gets the same 409 as #98's
payment-link route. The catalog endpoint (`GET …/plans`) is **un-gated** so the page renders before
billing is configured; only the checkout *button* needs billing on.

### 3. A price registry makes bootstrap idempotent (`billing_plan_prices`)
The owner's Stripe account is one account; creating a fresh product per checkout click would litter it.
We persist `(workspace_id, plan_key, provider) → (product_id, price_id)` with that composite as the
**primary key**, so "create products/prices idempotently" is an `ON CONFLICT DO NOTHING` upsert.
`billing:bootstrap` pre-warms the registry for all plans; checkout self-heals (find-or-create) so
`NoneProvider` dev/CI needs no bootstrap step at all.

### 4. Activation is exactly-once via the merged webhook's dedupe
Activation hangs off `BillingManager.ingestWebhook` through an optional `planActivator` dep — when a
deduped payment event carries `metadata.kind="plan_checkout"`, the manager upserts `workspace_plans` from
`planCaps`. Because dedupe returns **before** the activation branch, a replayed delivery never
re-activates. This keeps a single activation path (the webhook) and reuses #98's idempotency rather than
inventing a second one. `workspace_plans` is the observable "caps updated" state the acceptance test
asserts.

### 5. Outbound money stays structurally impossible (unchanged)
#125 adds two operations — mint a plan checkout link, record an inbound webhook — both inbound. The
`BillingProvider` seam still has no refund/payout/transfer; `safety.ts` still fails closed; refunds remain
a #13 approval-gated, recorded-only action handled manually in the Stripe dashboard. **No autonomous
refunds.**

### 6. Secrets: owner-pasted via `fly secrets set`, never agent-handled
The repo carries **zero** key material. `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` are **names** on the
#25 secrets path. The owner runs:

```
fly secrets set STRIPE_SECRET_KEY=sk_live_…   --app reload-api
fly secrets set STRIPE_WEBHOOK_SECRET=whsec_…  --app reload-api
fly ssh console --app reload-api -C "pnpm -C platform/apps/server billing:bootstrap <workspaceId>"
```

Everything works on `NoneProvider` (zero network, zero spend) until those land. The bootstrap script logs
only ids/counts — never a secret value.

## Consequences
- **Positive:** ipop.ai can charge real customers through the owner's Stripe account in one PR, with every
  #98 safety invariant intact and zero new payments code to operate. The catalog is one pure module; a
  fourth plan is a one-line edit. Caps are persisted and queryable.
- **Negative / follow-ups:** `workspace_plans` is the source of truth for plan caps, but wiring those caps
  back into the #71 admission chokepoint (so the budget actually throttles sessions) is a deliberate
  follow-up seam — this PR persists + exposes the caps but does not rewrite admission. Per-seat
  enforcement and proration/cancellation flows are out of scope (handled in the Stripe dashboard for now).
- **Reversible:** a second provider (Paddle/Lemon Squeezy) is a new #98 adapter, not a rewrite; the plan
  layer is provider-agnostic.
