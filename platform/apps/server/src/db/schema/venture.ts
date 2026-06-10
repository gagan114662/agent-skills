import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import { tasks } from "./tasks.js";

/**
 * Venture Loop persistence (#96, ADR-0049). Three workspace-scoped tables — the typed intake idea,
 * the dual-persona scorecards, and the per-pass iteration log. All `workspace_id`-scoped with
 * `onDelete: cascade` (the #3 tenant boundary). The admission gate (`venture/admission.ts`) selects a
 * `funded` + `FUND` + unexpired scorecard; the loop (`venture/service.ts`) writes the iteration log.
 */

export const IDEA_STATUSES = [
  "intake",
  "scoring",
  "iterating",
  "funded",
  "killed",
  "escalated",
] as const;

export const VENTURE_VERDICTS = ["FUND", "ITERATE", "KILL", "ESCALATE"] as const;

export const EVALUATION_STATUSES = ["active", "terminal"] as const;

/** The intake artifact (problem, user, insight, wedge, market path) + its lifecycle status. */
export const ventureIdeas = pgTable(
  "venture_ideas",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    problem: text("problem").notNull(),
    targetUser: text("target_user").notNull(),
    insight: text("insight").notNull(),
    wedge: text("wedge").notNull(),
    marketPath: text("market_path").notNull(),
    status: text("status", { enum: IDEA_STATUSES }).notNull().default("intake"),
    epicTaskId: uuid("epic_task_id").references(() => tasks.id, { onDelete: "set null" }),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStatus: index("venture_ideas_workspace_status_idx").on(t.workspaceId, t.status),
    statusCk: check(
      "venture_ideas_status_ck",
      sql`${t.status} IN ('intake','scoring','iterating','funded','killed','escalated')`,
    ),
  }),
);

/** A persisted scorecard: the adversarially-weighted aggregate + the two persona breakdowns. */
export const ventureScorecards = pgTable(
  "venture_scorecards",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ideaId: uuid("idea_id")
      .notNull()
      .references(() => ventureIdeas.id, { onDelete: "cascade" }),
    iteration: integer("iteration").notNull(),
    score: integer("score").notNull(),
    verdict: text("verdict", { enum: VENTURE_VERDICTS }),
    advocate: jsonb("advocate").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    reviewer: jsonb("reviewer").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    reasoning: text("reasoning").notNull().default(""),
    funded: boolean("funded").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    byIdea: index("venture_scorecards_workspace_idea_idx").on(t.workspaceId, t.ideaId),
    byExpiry: index("venture_scorecards_workspace_expiry_idx").on(t.workspaceId, t.expiresAt),
    verdictCk: check(
      "venture_scorecards_verdict_ck",
      sql`${t.verdict} IS NULL OR ${t.verdict} IN ('FUND','ITERATE','KILL','ESCALATE')`,
    ),
  }),
);

/** The per-pass iteration log: the loop's compact working memory + audit trail. */
export const ventureIterations = pgTable(
  "venture_iterations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ideaId: uuid("idea_id")
      .notNull()
      .references(() => ventureIdeas.id, { onDelete: "cascade" }),
    iteration: integer("iteration").notNull(),
    score: integer("score").notNull(),
    verdict: text("verdict", { enum: VENTURE_VERDICTS }).notNull(),
    gapList: jsonb("gap_list").$type<unknown>().notNull().default(sql`'{}'::jsonb`),
    angles: jsonb("angles").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    evidence: jsonb("evidence").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    workingMemorySummary: text("working_memory_summary").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byIdea: index("venture_iterations_workspace_idea_idx").on(t.workspaceId, t.ideaId),
    verdictCk: check(
      "venture_iterations_verdict_ck",
      sql`${t.verdict} IN ('FUND','ITERATE','KILL','ESCALATE')`,
    ),
  }),
);

/**
 * Durable loop state (#96 hardening): one row per idea tracking where the evaluation is — the current
 * iteration, the angles already tried+failed, the latest score, accrued cost, and whether it has
 * reached a terminal verdict. A crash/restart resumes from here (no in-memory-only loop state), and
 * the scheduled tick reads `status='active'` rows as its work-list.
 */
export const ventureEvaluations = pgTable(
  "venture_evaluations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ideaId: uuid("idea_id")
      .notNull()
      .references(() => ventureIdeas.id, { onDelete: "cascade" }),
    status: text("status", { enum: EVALUATION_STATUSES }).notNull().default("active"),
    terminalVerdict: text("terminal_verdict", { enum: VENTURE_VERDICTS }),
    currentIteration: integer("current_iteration").notNull().default(0),
    failedAngles: jsonb("failed_angles").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lastScore: integer("last_score"),
    costCents: integer("cost_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ideaUniq: unique("venture_evaluations_idea_uniq").on(t.ideaId),
    byStatus: index("venture_evaluations_workspace_status_idx").on(t.workspaceId, t.status),
    statusCk: check("venture_evaluations_status_ck", sql`${t.status} IN ('active','terminal')`),
    verdictCk: check(
      "venture_evaluations_verdict_ck",
      sql`${t.terminalVerdict} IS NULL OR ${t.terminalVerdict} IN ('FUND','ITERATE','KILL','ESCALATE')`,
    ),
  }),
);
