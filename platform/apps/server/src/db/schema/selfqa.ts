import { pgTable, uuid, text, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Self-QA Loop persistence (#171, ADR-0171). One workspace-scoped table, `selfqa_runs`: the run-history
 * audit trail (one row per synthetic-user QA pass) read by the #104 founder console. Findings are NOT
 * stored here — dedup lives in the #117 flywheel (DB path) or GitHub (CI path), so there is one dedup
 * store, never two. Only `workspace_id` carries the #3 tenant boundary (`onDelete: cascade`); every row
 * lives under the dedicated SYNTHETIC workspace, never a real tenant.
 */

export const SELFQA_RUN_STATUSES = ["running", "passed", "failed"] as const;
export const SELFQA_SUITES = ["smoke", "full"] as const;

export const selfqaRuns = pgTable(
  "selfqa_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    suite: text("suite", { enum: SELFQA_SUITES }).notNull(),
    target: text("target").notNull(),
    status: text("status", { enum: SELFQA_RUN_STATUSES }).notNull().default("running"),
    checksTotal: integer("checks_total").notNull().default(0),
    checksFailed: integer("checks_failed").notNull().default(0),
    criticalCount: integer("critical_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    byWorkspaceStarted: index("selfqa_runs_workspace_started_idx").on(t.workspaceId, t.startedAt),
    suiteCk: check("selfqa_runs_suite_ck", sql`${t.suite} IN ('smoke','full')`),
    statusCk: check("selfqa_runs_status_ck", sql`${t.status} IN ('running','passed','failed')`),
  }),
);
