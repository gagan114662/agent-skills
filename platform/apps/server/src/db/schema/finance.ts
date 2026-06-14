import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { ventureIdeas } from "./venture.js";
import { members } from "./identities.js";

/**
 * Finance Ledger (#194, ADR-0194). TWO workspace-scoped tables — the continuous per-venture ledger and
 * the closed monthly books. Like #173's `founder_briefings`, this is the finance layer's OWN bookkeeping
 * about money the company already received/spent (sourced from external receipts), NOT new authority over
 * billing: nothing here moves money. Tenant boundary is `workspace_id` (#3, `onDelete: cascade`).
 *
 * The premortem (#200) is in the columns: every entry carries `verified` + `source` + `source_ref`
 * (the external receipt it dedupes on), so estimate-derived numbers are honestly labeled UNVERIFIED.
 */

export const LEDGER_DIRECTIONS = ["credit", "debit"] as const;
export const LEDGER_SOURCES = ["stripe_event", "tenant_usage", "manual"] as const;

/**
 * The continuous double-entry-ish ledger. One row per posting; `direction` carries the sign,
 * `amount_cents` is always ≥ 0. Idempotency: `unique(workspace_id, source, source_ref)` — re-posting the
 * same external receipt (the engine runs every tick) is a no-op/upsert, never a double-count, exactly as
 * `revenue_events` dedupes on `(workspace_id, provider_event_id)`.
 */
export const financeLedgerEntries = pgTable(
  "finance_ledger_entries",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The venture this maps to, or NULL for a workspace-level (unattributed) entry. */
    ventureIdeaId: uuid("venture_idea_id").references(() => ventureIdeas.id, { onDelete: "set null" }),
    /** `credit` (revenue inflow) | `debit` (cost outflow). */
    direction: text("direction", { enum: LEDGER_DIRECTIONS }).notNull(),
    /** Coarse account, e.g. `revenue.stripe`, `cost.model`, `cost.infra`, `cost.ad`. */
    category: text("category").notNull(),
    /** Always ≥ 0; the sign is the `direction`. */
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("usd"),
    /** TRUE only when backed by an external receipt (a Stripe event). Estimates/manual are FALSE. */
    verified: boolean("verified").notNull(),
    /** `stripe_event` (verified) | `tenant_usage` (estimate) | `manual` (owner-entered). */
    source: text("source", { enum: LEDGER_SOURCES }).notNull(),
    /** The external receipt id this posting dedupes on (provider event id / usage window key / ref). */
    sourceRef: text("source_ref").notNull(),
    /** When the economic event happened — the period-bucketing basis (NOT created_at). */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    memo: text("memo"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("finance_ledger_workspace_idx").on(t.workspaceId, t.occurredAt),
    byVenture: index("finance_ledger_venture_idx").on(t.workspaceId, t.ventureIdeaId),
    sourceUk: unique("finance_ledger_source_uk").on(t.workspaceId, t.source, t.sourceRef),
    directionCk: check("finance_ledger_direction_ck", sql`${t.direction} IN ('credit','debit')`),
    sourceCk: check("finance_ledger_source_ck", sql`${t.source} IN ('stripe_event','tenant_usage','manual')`),
    amountCk: check("finance_ledger_amount_ck", sql`${t.amountCents} >= 0`),
  }),
);

/**
 * The closed monthly book per venture-scope + period — the "books that close themselves" snapshot the
 * #173 weekly report attaches. `venture_idea_id` NULL = the workspace-level book. One book per
 * scope+period via a `COALESCE(venture_idea_id, …)` unique index (the migration defines it, since a
 * plain `unique()` would treat NULLs as distinct and allow duplicate workspace-level books).
 */
export const financeClosePacks = pgTable(
  "finance_close_packs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureIdeaId: uuid("venture_idea_id").references(() => ventureIdeas.id, { onDelete: "set null" }),
    /** `YYYY-MM` — the close period. */
    periodKey: text("period_key").notNull(),
    currency: text("currency").notNull().default("usd"),
    revenueCents: integer("revenue_cents").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    /** The externally-verified subset of `revenue_cents` (all Stripe revenue today). */
    verifiedRevenueCents: integer("verified_revenue_cents").notNull().default(0),
    /** The externally-verified subset of `cost_cents`. */
    verifiedCostCents: integer("verified_cost_cents").notNull().default(0),
    /** `revenue_cents − cost_cents`, signed. */
    netCents: integer("net_cents").notNull().default(0),
    /** Basis points (0–10000) of the period's money magnitude that is externally verified (#200). */
    verifiedShareBps: integer("verified_share_bps").notNull().default(0),
    entryCount: integer("entry_count").notNull().default(0),
    /** `{cacCents,ltvCents,marginBps,ltvToCacX100}` — each null when its inputs are unknown. */
    unitEconomics: jsonb("unit_economics").notNull().default(sql`'{}'::jsonb`),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("finance_close_packs_workspace_idx").on(t.workspaceId, t.periodKey),
    revenueCk: check("finance_close_packs_revenue_ck", sql`${t.revenueCents} >= 0`),
    costCk: check("finance_close_packs_cost_ck", sql`${t.costCents} >= 0`),
    verifiedShareCk: check(
      "finance_close_packs_share_ck",
      sql`${t.verifiedShareBps} >= 0 AND ${t.verifiedShareBps} <= 10000`,
    ),
  }),
);
