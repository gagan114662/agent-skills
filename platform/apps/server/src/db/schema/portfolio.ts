import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import { ventureIdeas } from "./venture.js";
import { approvalRequests } from "./approvals.js";

/**
 * Portfolio Lifecycle review ledger (#107, ADR-0107). One workspace-scoped table: the durable record
 * of every per-launched-venture review — the evidence snapshot it was decided on (growth/moat/demand/
 * revenue/cost/age), the decision, the reasons, and the SUNSET approval link + lifecycle status. The
 * dashboard (`GET /workspaces/:wid/portfolio`) and the Founder Console (#104) are projections of these
 * rows. `workspace_id`-scoped with `onDelete: cascade` (#3 tenant boundary); `venture_idea_id` cascades
 * so a venture's reviews die with it; `approval_request_id` SET NULL so a pruned approval doesn't orphan.
 */

export const PORTFOLIO_DECISIONS_DB = ["DOUBLE_DOWN", "MAINTAIN", "PIVOT", "SUNSET"] as const;
export const PORTFOLIO_REVIEW_STATUSES_DB = [
  "recorded",
  "sunset_pending",
  "sunset_executed",
  "sunset_rejected",
] as const;

export const portfolioReviews = pgTable(
  "portfolio_reviews",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureIdeaId: uuid("venture_idea_id")
      .notNull()
      .references(() => ventureIdeas.id, { onDelete: "cascade" }),
    decision: text("decision", { enum: PORTFOLIO_DECISIONS_DB }).notNull(),
    /** 0–100 composite portfolio-health score at review time. */
    score: integer("score").notNull(),
    growthScore: integer("growth_score").notNull(),
    moatScore: integer("moat_score").notNull(),
    moatStagnant: boolean("moat_stagnant").notNull(),
    demandSignals: integer("demand_signals").notNull(),
    revenueCents: integer("revenue_cents").notNull(),
    monthlyCostCents: integer("monthly_cost_cents").notNull(),
    /** `revenue_cents − monthly_cost_cents` (signed; negative = burning). */
    netCents: integer("net_cents").notNull(),
    ageInDays: integer("age_in_days").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status", { enum: PORTFOLIO_REVIEW_STATUSES_DB }).notNull().default("recorded"),
    /** The #13 approval request gating a SUNSET (set when `requestSunset` gates the kill). */
    approvalRequestId: uuid("approval_request_id").references(() => approvalRequests.id, {
      onDelete: "set null",
    }),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byVenture: index("portfolio_reviews_workspace_venture_idx").on(t.workspaceId, t.ventureIdeaId),
    byDecision: index("portfolio_reviews_workspace_decision_idx").on(t.workspaceId, t.decision),
    byCreated: index("portfolio_reviews_workspace_created_idx").on(t.workspaceId, t.createdAt),
    decisionCk: check(
      "portfolio_reviews_decision_ck",
      sql`${t.decision} IN ('DOUBLE_DOWN','MAINTAIN','PIVOT','SUNSET')`,
    ),
    statusCk: check(
      "portfolio_reviews_status_ck",
      sql`${t.status} IN ('recorded','sunset_pending','sunset_executed','sunset_rejected')`,
    ),
  }),
);
