# Spec: Pricing page on ipop.ai wired to Stripe (Issue #125)

> Implements [#125](https://github.com/gagan114662/agent-skills/issues/125). Lifecycle: **DEFINE**
> artifact (`spec-driven-development`). Builds directly on the **already-merged** [#98 Stripe revenue
> rails](98-stripe-revenue-rails.md) ([ADR-0043](../adrs/0043-stripe-revenue-rails.md)) — reuses the
> `BillingProvider` adapter seam, the no-network `NoneBillingProvider` default, the signature-verified
> webhook ingest + dedupe, the per-tenant `SecretsResolver`, the redactor, the egress gate, and the
> `billing` config block. Also builds on [#122 ipop brand + shell](../adrs/0050-founder-console.md
> #122) (`brand.ts`, the 4-tab `Workspace` shell), [#71 cloud scale](40-cloud-scale.md) (`tenant_usage`
> + per-tenant caps), [#13 approval gates](../adrs/0013-approval-gates.md) (outbound money is gated +
> recorded-only), and [#9 RBAC/IDOR](09-registry-rbac.md) (workspace-scoped reads).

## ⚠️ Decision first — build vs. integrate
**Reuse the merged #98 rails; add a thin pricing/plan layer on top — do not build a second billing
path.** See [ADR-0125](../adrs/0125-pricing-plans.md). #98 already gives us inbound-only checkout, signed
webhooks, dedupe, redaction, and the provider seam. #125 adds exactly three things #98 left open: (1) a
**pure plan catalog** (Starter/Pro/Agency) that maps to tenant caps, (2) a **workspace-scoped checkout**
(today's #98 checkout is session-scoped — it needs a deployed app + channel), and (3) **plan activation**
on the merged webhook (mark the workspace's plan + update its caps). Everything else is #98, unchanged.

## Objective
**What:** A `/pricing` page on the ipop.ai web console showing **three real plans** (Starter / Pro /
Agency) defined in a pure config module. Each plan maps to tenant caps — **agent seats**, **monthly
session budget** (→ `tenant_usage` cost cap), **department fleet size**. Clicking a plan opens a real
Stripe Checkout / payment link minted through the **#98 `BillingProvider` seam** (inbound-only). A
`billing:bootstrap` script creates the Stripe products/prices **idempotently** when
`BILLING_PROVIDER=stripe` and the key is present; the default `NoneProvider` keeps dev/CI at **zero
network**. The merged, signature-verified webhook **activates the plan** for the workspace and **updates
its budget caps**; the existing `revenue_events` / `revenue_evidence` keep flowing to the #96 scorecard.

**Why:** ipop.ai had no pricing page and no way to charge. "An autonomous marketing agency that cannot
charge is a demo." This turns a visitor into a paying customer through the owner's real Stripe account
(Mathematricks Fund, `acct_…`) — while keeping every safety invariant #98 established.

## Plans (the pure catalog → caps)
`billing/plans.ts` is a **pure, dependency-free** module. Each plan:

| Plan    | Price (USD/mo) | Agent seats | Monthly session budget | Dept. fleet size | Featured |
|---------|----------------|-------------|------------------------|------------------|----------|
| Starter | $49            | 3           | $200  (20 000¢)        | 1                |          |
| Pro     | $199           | 10          | $1 000 (100 000¢)      | 3                | ★        |
| Agency  | $499           | 30          | $5 000 (500 000¢)      | 10               |          |

`planCaps(plan)` → `{ agentSeats, monthlySessionBudgetCents, fleetSize }`. The monthly session budget
maps to the `tenant_usage` / `[scale].budgetCents` cost cap — the spend ceiling on a tenant's agent
sessions per window. The catalog is the single source of truth for both the web page and the server.

## Surfaces
- **`GET /workspaces/:wid/billing/plans`** → `{ plans: PlanDto[], current: ActivePlanDto | null }`.
  Un-gated (catalog is static; `current` is null until a plan is activated) so the page always renders,
  even before billing is configured.
- **`POST /workspaces/:wid/billing/checkout`** `{ planKey }` → `201 { url }`. **Gated** exactly like
  #98's payment-link route: `409` when the tenant has no `billing` config (opt-in) or data-privacy mode
  forbids egress; `502` (redacted) on a provider error. Workspace-scoped (assertWorkspace → IDOR-safe).
- **`POST /billing/webhook/:wid`** — the **merged #98 webhook**, unchanged on the wire. When a payment
  event carries `metadata.kind = "plan_checkout"` + `metadata.planKey`, the manager additionally
  **activates the plan**. Dedupe (the #98 unique key) makes activation exactly-once under replay.

## Data (migration `0125_pricing_plans`)
Two additive, workspace-scoped tables (number-by-issue to dodge sibling collisions):
- **`workspace_plans`** (PK `workspace_id`): `plan_key`, `status`, `agent_seats`,
  `monthly_session_budget_cents`, `fleet_size`, `provider_event_id` (audit), `activated_at`,
  `updated_at`. The source of truth for "what plan is this workspace on and what are its caps." Upserted
  on activation — **this is the observable "caps updated" state**.
- **`billing_plan_prices`** (PK `(workspace_id, plan_key, provider)`): `product_id`, `price_id`. The
  idempotent price registry. `bootstrap` and checkout find-or-create here; the composite PK is what makes
  "create products/prices idempotently" a one-line `ON CONFLICT DO NOTHING`.

No secret ever lands in either table (the #98 invariant, unchanged).

## Bootstrap (`pnpm -C platform/apps/server billing:bootstrap <workspaceId>`)
`billing/bootstrap-cli.ts` resolves the env provider (#98 `createBillingProvider`) and, **for each plan**,
`ensurePrice` (find-or-create in `billing_plan_prices`). With `BILLING_PROVIDER` unset/`none` it logs
"NoneProvider — zero network" and creates synthetic ids (dev/CI never spend). With `stripe` + a resolved
key it creates the real products/prices **once** (a second run is a no-op). It **never prints a secret
value** (the resolver returns values; the script logs only ids/counts).

## Secrets — the owner pastes them; the agent never touches key material
Everything runs dark on `NoneProvider` until the owner sets the secrets on Fly. Documented commands
(also in the PR body and ADR-0125) — run by the **owner**, never by the agent, never committed:

```
fly secrets set STRIPE_SECRET_KEY=sk_live_…       --app reload-api
fly secrets set STRIPE_WEBHOOK_SECRET=whsec_…      --app reload-api
# then, once, to mint the real products/prices:
fly ssh console --app reload-api -C "pnpm -C platform/apps/server billing:bootstrap <workspaceId>"
```

The repo contains **zero** key material. `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` are **names** on
the #25 secrets path (the #98 convention); values live only in Fly secrets.

## Safety invariants (inherited from #98, unchanged)
- **Outbound money is structurally impossible.** The `BillingProvider` seam has no refund/payout/transfer
  method; `safety.ts` fails closed; refunds are a #13 approval-gated, recorded-only action. #125 adds two
  money operations and both only **collect**: mint a plan checkout link, record an inbound webhook. No
  autonomous refunds.
- **Redaction**: provider errors + the stored webhook body pass through the per-tenant redactor (#98).
- **Opt-in + egress gate**: checkout requires the `billing` config block and respects data-privacy mode.
- **IDOR**: all reads/writes are workspace-scoped (#9).

## Acceptance
1. `/pricing` renders the three plans (ipop voice) and highlights the active one.
2. Integration test (real PG+Redis, `NoneProvider`) proves: `GET plans` → 3 plans, `current` null →
   `POST checkout {pro}` → 201 url → **signed webhook** (`metadata.kind=plan_checkout, planKey=pro`) →
   `GET plans` `current.planKey="pro"` with **Pro caps** (caps updated) → replay is idempotent.
3. `checkout` → 409 when billing not enabled; IDOR-safe across workspaces.
4. Bootstrap is idempotent (second run creates nothing new) and zero-network under `NoneProvider`.
5. Zero secrets in the repo; works dark until keys are pasted.

TDD failing-first; spec (this) + [ADR-0125](../adrs/0125-pricing-plans.md); one PR `feat(#125): pricing +
stripe checkout` with `Closes #125`; **video gate waived by the owner**.
