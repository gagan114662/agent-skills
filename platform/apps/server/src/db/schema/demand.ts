import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  doublePrecision,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import { ventureIdeas } from "./venture.js";

/**
 * Demand Validation Rails persistence (#101, ADR-0101). Three workspace-scoped tables — the locked
 * experiment spec, the externally-attributed funnel signals, and the ethics auto-refund audit. All
 * `workspace_id`-scoped with `onDelete: cascade` (the #3 tenant boundary). Additive + independent of
 * every other branch's schema; `venture_idea_id` is a soft link to the #96 idea (SET NULL).
 */

export const DEMAND_AVAILABILITY = ["available", "waitlist", "preorder"] as const;
export const DEMAND_EXPERIMENT_STATUSES = ["registered", "live", "concluded"] as const;
export const DEMAND_SIGNAL_CLASSES = ["visit", "cta_click", "checkout_started", "waitlist", "paid"] as const;

/** The locked experiment spec + lifecycle. The bar columns are written at register and never updated. */
export const demandExperiments = pgTable(
  "demand_experiments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureIdeaId: uuid("venture_idea_id").references(() => ventureIdeas.id, { onDelete: "set null" }),
    hypothesis: text("hypothesis").notNull(),
    successClass: text("success_class", { enum: DEMAND_SIGNAL_CLASSES }).notNull(),
    denominatorClass: text("denominator_class", { enum: DEMAND_SIGNAL_CLASSES }).notNull(),
    passThreshold: doublePrecision("pass_threshold").notNull(),
    minSample: integer("min_sample").notNull(),
    windowStartMs: bigint("window_start_ms", { mode: "number" }).notNull(),
    windowEndMs: bigint("window_end_ms", { mode: "number" }).notNull(),
    availability: text("availability", { enum: DEMAND_AVAILABILITY }).notNull(),
    disclosure: text("disclosure"),
    status: text("status", { enum: DEMAND_EXPERIMENT_STATUSES }).notNull().default("registered"),
    landingUrl: text("landing_url"),
    checkoutUrl: text("checkout_url"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("demand_experiments_workspace_idx").on(t.workspaceId),
    byIdea: index("demand_experiments_idea_idx").on(t.ventureIdeaId),
  }),
);

/**
 * One externally-attributed funnel signal (visit → cta_click → checkout_started → waitlist → paid).
 * `external_ref` is the attribution (a Stripe event id, an anonymized visitor token). Deduped per
 * experiment by the external ref so a replayed webhook never double-counts.
 */
export const demandSignals = pgTable(
  "demand_signals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => demandExperiments.id, { onDelete: "cascade" }),
    ventureIdeaId: uuid("venture_idea_id").references(() => ventureIdeas.id, { onDelete: "set null" }),
    signalClass: text("signal_class", { enum: DEMAND_SIGNAL_CLASSES }).notNull(),
    source: text("source").notNull(),
    externalRef: text("external_ref").notNull(),
    amountCents: integer("amount_cents").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byExperiment: index("demand_signals_experiment_idx").on(t.experimentId),
    byIdea: index("demand_signals_idea_idx").on(t.ventureIdeaId),
    // Webhook/funnel idempotency: at most one signal per (workspace, experiment, external ref).
    dedupe: unique("demand_signals_experiment_ref_uq").on(t.workspaceId, t.experimentId, t.externalRef),
  }),
);

/** The ethics auto-refund audit — one row per pre-availability charge that was instantly refunded. */
export const demandRefunds = pgTable(
  "demand_refunds",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => demandExperiments.id, { onDelete: "cascade" }),
    externalRef: text("external_ref").notNull(),
    amountCents: integer("amount_cents").notNull().default(0),
    currency: text("currency").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byExperiment: index("demand_refunds_experiment_idx").on(t.experimentId),
  }),
);
