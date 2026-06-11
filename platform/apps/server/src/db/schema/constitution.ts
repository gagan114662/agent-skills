import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { ventureIdeas } from "./venture.js";

/**
 * Constitution-violation persistence (#146, ADR-0146). One workspace-scoped table — the durable feed of
 * flagged violations. The Founder Console reads the `open` rows into its attention list (the #104 pull-
 * based pattern); the venture-loop constitution sink writes them. Violations FLAG — they are never a
 * silent auto-correction, and this table is the audit trail of every flag raised.
 */

export const VIOLATION_SEVERITIES = ["block", "high", "medium", "low"] as const;
export const VIOLATION_STAGES = ["SOURCE", "FUND", "KILL"] as const;
export const VIOLATION_STATUSES = ["open", "acknowledged"] as const;

export const constitutionViolations = pgTable(
  "constitution_violations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The venture idea the decision was about. Cascades with the idea. */
    ideaId: uuid("idea_id")
      .notNull()
      .references(() => ventureIdeas.id, { onDelete: "cascade" }),
    /** The Article roman-numeral (I..VIII). */
    article: text("article").notNull(),
    /** Stable machine code (e.g. `love_paradigm_unmet`) — the flywheel fingerprint key. */
    code: text("code").notNull(),
    severity: text("severity", { enum: VIOLATION_SEVERITIES }).notNull(),
    stage: text("stage", { enum: VIOLATION_STAGES }).notNull(),
    /** The verdict under consideration when the violation was raised. */
    verdict: text("verdict").notNull(),
    message: text("message").notNull(),
    status: text("status", { enum: VIOLATION_STATUSES }).notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceStatus: index("constitution_violations_workspace_status_idx").on(
      t.workspaceId,
      t.status,
    ),
    byIdea: index("constitution_violations_idea_idx").on(t.ideaId),
    severityCk: check(
      "constitution_violations_severity_ck",
      sql`${t.severity} IN ('block','high','medium','low')`,
    ),
    stageCk: check(
      "constitution_violations_stage_ck",
      sql`${t.stage} IN ('SOURCE','FUND','KILL')`,
    ),
    statusCk: check(
      "constitution_violations_status_ck",
      sql`${t.status} IN ('open','acknowledged')`,
    ),
  }),
);
