import { pgTable, uuid, text, integer, jsonb, timestamp, index, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { ventureIdeas } from "./venture.js";
import { members } from "./identities.js";

/**
 * Venture monetization rails (#188, ADR-0188): every venture can charge money, the owner holds the keys.
 * THREE workspace-scoped tables. The tables are named with the NON-governed `monetization_` prefix on
 * purpose — they FK `venture_ideas` (which is fine) but creating a `venture_*`-named table would trip the
 * #155 colocation gate; #194 used `finance_*` for the same reason.
 *
 * The premortem (#200) is in the columns:
 *   - **FM#4 money is irreversible**: a `monetization_plans` row is a DRAFT (reversible, free) until the
 *     owner approves its activation through the #13 money queue; `activation_request_id` soft-links that
 *     decision and `status` never reaches `active` without it.
 *   - **FM#2 external receipts only**: `monetization_revenue` holds ONLY signature-verified provider
 *     webhook events (a real, dedupe-keyed Stripe receipt) — the per-venture revenue that feeds the #194
 *     ledger → #173 weekly P&L. Projections live on the experiment row, clearly labeled, never here.
 * Secrets never land in any of these tables; the per-venture Stripe key lives in the #192 write-only vault.
 */

// Local to the schema (the exported, canonical copies live in `monetization/pricing.ts`); not re-exported
// through `schema/index.ts` to avoid colliding with growth.js's own `EXPERIMENT_STATUSES`.
const PLAN_STATUSES = ["draft", "pending_activation", "active", "archived"] as const;
const EXPERIMENT_STATUSES = ["proposed", "active", "concluded", "abandoned"] as const;

/**
 * A pricing plan for a venture: a product + price the fleet drafts (#188 AC1). It is created `draft`
 * (no Stripe object, no money) and only mints a REAL hosted payment link once the owner approves its
 * activation through the #13 money queue (`status` → `active`, `provider_*`/`url` filled). A re-price is
 * a new pending activation that records `previous_amount_cents` so the owner sees the before→after.
 */
export const monetizationPlans = pgTable(
  "monetization_plans",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The venture this plan charges for (the per-venture Stripe account it activates against). */
    ventureIdeaId: uuid("venture_idea_id").references(() => ventureIdeas.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("usd"),
    interval: text("interval"), // day|week|month|year | null (one-time)
    status: text("status", { enum: PLAN_STATUSES }).notNull().default("draft"),
    /** Provider that minted the live objects (none|stripe); set on activation. */
    provider: text("provider"),
    productId: text("product_id"),
    priceId: text("price_id"),
    providerLinkId: text("provider_link_id"),
    url: text("url"),
    /** Soft link to the #13 MONEY decision the owner approves to activate/re-price (audit trail). */
    activationRequestId: uuid("activation_request_id"),
    /** The price this plan replaced, when this is a re-price (for the before→after on the queue card). */
    previousAmountCents: integer("previous_amount_cents"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (t) => ({
    byWorkspace: index("monetization_plans_workspace_idx").on(t.workspaceId),
    byVenture: index("monetization_plans_venture_idx").on(t.workspaceId, t.ventureIdeaId),
    statusCk: check(
      "monetization_plans_status_ck",
      sql`${t.status} IN ('draft','pending_activation','active','archived')`,
    ),
    amountCk: check("monetization_plans_amount_ck", sql`${t.amountCents} > 0`),
  }),
);

/**
 * A pricing experiment a lens/bid proposes (#188 AC3). It carries the `projected_delta_cents` forecast
 * (labeled UNVERIFIED in code) at proposal time; activation requires the owner's yes (the same #13 money
 * decision as a plan activation). Once concluded, `verified_revenue_cents` / `realized_delta_cents` hold
 * the externally-verified outcome (a real Stripe receipt over the window) — never an estimate.
 */
export const monetizationExperiments = pgTable(
  "monetization_experiments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureIdeaId: uuid("venture_idea_id").references(() => ventureIdeas.id, { onDelete: "set null" }),
    /** The plan this experiment re-prices, when it targets an existing plan. */
    planId: uuid("plan_id").references(() => monetizationPlans.id, { onDelete: "set null" }),
    hypothesis: text("hypothesis").notNull(),
    baselineAmountCents: integer("baseline_amount_cents").notNull(),
    candidateAmountCents: integer("candidate_amount_cents").notNull(),
    /** The projected baseline per-period REVENUE (price × conversions) — the bar the verified result beats. */
    baselineRevenueCents: integer("baseline_revenue_cents").notNull().default(0),
    /** The projected per-period revenue delta at proposal time (UNVERIFIED — a forecast, not a result). */
    projectedDeltaCents: integer("projected_delta_cents").notNull().default(0),
    status: text("status", { enum: EXPERIMENT_STATUSES }).notNull().default("proposed"),
    /** Soft link to the #13 MONEY decision the owner approves to run the test (audit trail). */
    activationRequestId: uuid("activation_request_id"),
    /** Externally-verified revenue collected during the test window (NULL until concluded). */
    verifiedRevenueCents: integer("verified_revenue_cents"),
    /** Verified revenue − baseline (the forecast-vs-reality signal; NULL until concluded). */
    realizedDeltaCents: integer("realized_delta_cents"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    concludedAt: timestamp("concluded_at", { withTimezone: true }),
  },
  (t) => ({
    byWorkspace: index("monetization_experiments_workspace_idx").on(t.workspaceId),
    byVenture: index("monetization_experiments_venture_idx").on(t.workspaceId, t.ventureIdeaId),
    statusCk: check(
      "monetization_experiments_status_ck",
      sql`${t.status} IN ('proposed','active','concluded','abandoned')`,
    ),
  }),
);

/**
 * A per-venture revenue receipt (#188 AC4). Written ONLY by the per-venture webhook ingestion after the
 * delivery's signature is verified with that venture's own webhook secret (from the #192 vault) — so
 * every row is an externally-verified payment, attributed to the venture whose Stripe account it came
 * from. Deduped on `(workspace_id, provider_event_id)` like `revenue_events`, so a replayed webhook is a
 * no-op. The #194 finance ledger reads these as verified credits → the #173 weekly per-venture P&L.
 */
export const monetizationRevenue = pgTable(
  "monetization_revenue",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The venture this revenue belongs to (the account the webhook came from). */
    ventureIdeaId: uuid("venture_idea_id").references(() => ventureIdeas.id, { onDelete: "set null" }),
    provider: text("provider").notNull(), // stripe
    providerEventId: text("provider_event_id").notNull(),
    type: text("type").notNull(), // e.g. checkout.session.completed
    amountCents: integer("amount_cents").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    status: text("status").notNull(), // succeeded | paid | ...
    raw: jsonb("raw").notNull().default(sql`'{}'::jsonb`), // REDACTED webhook body
    /** When the payment happened — the period-bucketing basis for the ledger (NOT created_at). */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("monetization_revenue_workspace_idx").on(t.workspaceId, t.occurredAt),
    byVenture: index("monetization_revenue_venture_idx").on(t.workspaceId, t.ventureIdeaId),
    // Webhook idempotency: at most one row per (workspace, provider event id).
    dedupe: unique("monetization_revenue_event_uq").on(t.workspaceId, t.providerEventId),
    amountCk: check("monetization_revenue_amount_ck", sql`${t.amountCents} >= 0`),
  }),
);
