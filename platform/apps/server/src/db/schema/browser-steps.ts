import { pgTable, uuid, text, integer, bigint, boolean, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Agent browser runtime receipts (#174, ADR-0174). One workspace-scoped table, `browser_steps`: the
 * "why?" audit trail for what an agent's browser did. One row per step (allowed, denied, or awaiting a
 * #13 approval), carrying the URL, action, decision, approval id, and screenshot path. Only
 * `workspace_id` carries the #3 tenant boundary (`onDelete: cascade`); `session_id` is decoupled (no FK)
 * so a smoke/preflight session need not be a persisted agent session.
 */

export const BROWSER_STEP_TOOLS = [
  "navigate",
  "read_page",
  "screenshot",
  "scroll",
  "wait",
  "click",
  "type",
] as const;

export const BROWSER_STEP_DECISIONS = [
  "allow",
  "deny",
  "needs_approval",
  "forbidden",
  "disabled",
] as const;

export const browserSteps = pgTable(
  "browser_steps",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull(),
    stepNo: integer("step_no").notNull(),
    tool: text("tool", { enum: BROWSER_STEP_TOOLS }).notNull(),
    url: text("url"),
    sideEffectful: boolean("side_effectful").notNull(),
    decision: text("decision", { enum: BROWSER_STEP_DECISIONS }).notNull(),
    approvalRequestId: text("approval_request_id"),
    screenshotPath: text("screenshot_path"),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySession: index("browser_steps_session_idx").on(t.workspaceId, t.sessionId, t.stepNo),
    byWorkspaceCreated: index("browser_steps_workspace_created_idx").on(t.workspaceId, t.createdAt),
    toolCk: check(
      "browser_steps_tool_ck",
      sql`${t.tool} IN ('navigate','read_page','screenshot','scroll','wait','click','type')`,
    ),
    decisionCk: check(
      "browser_steps_decision_ck",
      sql`${t.decision} IN ('allow','deny','needs_approval','forbidden','disabled')`,
    ),
  }),
);
