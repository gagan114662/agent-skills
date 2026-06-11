import { pgTable, uuid, text, integer, boolean, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Eval-run audit trail (#155, ADR-0155 §4). One append-only row per offline eval-suite run for an agent
 * domain — the maintenance-as-code record the Anthropic playbook calls for (skills drift silently unless a
 * number is watched). Stores the drift forensics: skill/suite version, git SHA, model id, pass/fail counts,
 * tokens, and whether the run regressed against baseline. `pass_rate` is basis points (0–10000) so the
 * column stays integer + exact. Workspace-scoped (the #3 tenant boundary); otherwise self-contained.
 */
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    suiteVersion: text("suite_version").notNull(),
    gitSha: text("git_sha").notNull().default(""),
    modelId: text("model_id").notNull().default(""),
    total: integer("total").notNull(),
    passed: integer("passed").notNull(),
    failed: integer("failed").notNull(),
    /** Pass-rate in basis points (0–10000); divide by 10000 for the 0–1 rate. */
    passRate: integer("pass_rate").notNull(),
    tokens: integer("tokens").notNull().default(0),
    regressed: boolean("regressed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceAgent: index("eval_runs_workspace_agent_idx").on(t.workspaceId, t.agent, t.createdAt),
    countsCk: check("eval_runs_counts_ck", sql`${t.passed} >= 0 AND ${t.failed} >= 0 AND ${t.total} = ${t.passed} + ${t.failed}`),
    passRateCk: check("eval_runs_pass_rate_ck", sql`${t.passRate} >= 0 AND ${t.passRate} <= 10000`),
  }),
);
