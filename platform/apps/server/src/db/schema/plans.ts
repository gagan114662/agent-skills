import { sql } from "drizzle-orm";
import { check, index, pgTable, uuid, text, integer, timestamp, primaryKey, unique } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Pricing plans (#125, ADR-0125) — two additive, workspace-scoped tables on top of the merged #98 rails.
 * No secret ever lands here (the #98 invariant). `workspace_plans` is the source of truth for "what plan
 * is this workspace on and what are its caps"; `billing_plan_prices` is the idempotent price registry
 * that makes `billing:bootstrap` + checkout create no duplicate Stripe products.
 */

/**
 * The active plan for a workspace (one upserted row per workspace). The caps columns are the observable
 * "caps updated" state — written from the pure {@link import("../../billing/plans.js").planCaps} on
 * activation by the merged, deduped webhook.
 */
export const workspacePlans = pgTable("workspace_plans", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  planKey: text("plan_key").notNull(), // starter | pro | agency
  status: text("status").notNull().default("active"), // active | canceled
  agentSeats: integer("agent_seats").notNull(),
  monthlySessionBudgetCents: integer("monthly_session_budget_cents").notNull(),
  fleetSize: integer("fleet_size").notNull(),
  /** The webhook event id that activated this plan (audit; nullable for manual/seed activation). */
  providerEventId: text("provider_event_id"),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The idempotent product/price registry. The composite PK `(workspace_id, plan_key, provider)` is what
 * makes "create products/prices idempotently" a one-line ON CONFLICT DO NOTHING — a second bootstrap (or
 * a concurrent checkout) creates no duplicate Stripe product. Ids only — no secret, no amount.
 */
export const billingPlanPrices = pgTable(
  "billing_plan_prices",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    planKey: text("plan_key").notNull(),
    provider: text("provider").notNull(), // none | stripe
    productId: text("product_id").notNull(),
    priceId: text("price_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.planKey, t.provider] }),
  }),
);

export const pricingExperiments = pgTable(
  "pricing_experiments",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    controlVariantKey: text("control_variant_key").notNull(),
    minSampleSize: integer("min_sample_size").notNull().default(30),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("pricing_experiments_workspace_idx").on(t.workspaceId, t.status),
    statusCk: check("pricing_experiments_status_ck", sql`${t.status} IN ('active','paused','completed')`),
    sampleCk: check("pricing_experiments_min_sample_ck", sql`${t.minSampleSize} > 0`),
  }),
);

export const pricingExperimentVariants = pgTable(
  "pricing_experiment_variants",
  {
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => pricingExperiments.id, { onDelete: "cascade" }),
    variantKey: text("variant_key").notNull(),
    planKey: text("plan_key").notNull(),
    label: text("label").notNull(),
    weightBps: integer("weight_bps").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.experimentId, t.variantKey] }),
    weightCk: check("pricing_experiment_variants_weight_ck", sql`${t.weightBps} > 0`),
  }),
);

export const pricingExperimentAssignments = pgTable(
  "pricing_experiment_assignments",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => pricingExperiments.id, { onDelete: "cascade" }),
    subjectKey: text("subject_key").notNull(),
    variantKey: text("variant_key").notNull(),
    planKey: text("plan_key").notNull(),
    checkoutStartedAt: timestamp("checkout_started_at", { withTimezone: true }),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    revenueEventId: text("revenue_event_id"),
    revenueCents: integer("revenue_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byExperiment: index("pricing_experiment_assignments_experiment_idx").on(t.workspaceId, t.experimentId),
    subjectUq: unique("pricing_experiment_assignments_subject_uq").on(t.experimentId, t.subjectKey),
    revenueCk: check("pricing_experiment_assignments_revenue_ck", sql`${t.revenueCents} >= 0`),
  }),
);
