import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Self-Healing Ops persistence (#193, ADR-0174). One workspace-scoped table — the durable per-venture
 * remediation incident. A breached venture-surface signal (`uptime` / `error_rate` / `queue_depth` /
 * `stuck_agent`) opens a row (`firing`), the engine picks a reversibility-classed action and either
 * dispatches a remediation session (reversible) or a #13 approval (destructive), retries an auto action
 * ONCE, then escalates; recovery resolves the row and self-files a postmortem issue.
 *
 * The session / approval / deploy ids are **soft references** (no FK): audit history that may be pruned
 * independently, and the incident must outlive it. Only `workspace_id` carries the #3 tenant boundary
 * (`onDelete: cascade`). A **partial unique index** (in the migration) guarantees one open incident per
 * `(workspace_id, surface_key, signal)` so a sustained breach never floods the queue — mirrors
 * `sre_incidents`. The flywheel `ops_incident` failure class is a TS-only enum value (the column is
 * plain text with no DB CHECK), so no enum migration is needed.
 */

export const SELF_HEALING_STATUSES = ["firing", "remediating", "escalated", "resolved"] as const;
export const SELF_HEALING_SIGNALS = ["uptime", "error_rate", "queue_depth", "stuck_agent"] as const;
export const SELF_HEALING_ACTIONS = ["restart", "rollback", "scale_up", "escalate", "none"] as const;
export const SELF_HEALING_REVERSIBILITY = ["reversible", "cheap", "irreversible"] as const;

export const selfHealingRemediations = pgTable(
  "self_healing_remediations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The venture surface being monitored (a deployment host, a venture id, or the owner workspace). */
    surfaceKey: text("surface_key").notNull(),
    signal: text("signal", { enum: SELF_HEALING_SIGNALS }).notNull(),
    status: text("status", { enum: SELF_HEALING_STATUSES }).notNull().default("firing"),
    /** The chosen remediation action (null until decided). */
    action: text("action", { enum: SELF_HEALING_ACTIONS }),
    reversibility: text("reversibility", { enum: SELF_HEALING_REVERSIBILITY }),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    /** Soft refs to the #13 approval and the dispatched remediation session. */
    approvalRequestId: uuid("approval_request_id"),
    remediationSessionId: uuid("remediation_session_id"),
    /** How many auto-remediation attempts have run (retry-once ⇒ escalate when this exceeds the cap). */
    attempts: integer("attempts").notNull().default(0),
    observedValue: doublePrecision("observed_value"),
    thresholdValue: doublePrecision("threshold_value"),
    detail: text("detail"),
    /** The self-filed postmortem issue ref (null until resolved + filed). */
    postmortemIssueRef: text("postmortem_issue_ref"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    lastActionAt: timestamp("last_action_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceStatus: index("self_healing_remediations_workspace_status_idx").on(
      t.workspaceId,
      t.status,
    ),
    byVenture: index("self_healing_remediations_surface_idx").on(
      t.workspaceId,
      t.surfaceKey,
      t.signal,
    ),
    statusCk: check(
      "self_healing_remediations_status_ck",
      sql`${t.status} IN ('firing','remediating','escalated','resolved')`,
    ),
    signalCk: check(
      "self_healing_remediations_signal_ck",
      sql`${t.signal} IN ('uptime','error_rate','queue_depth','stuck_agent')`,
    ),
    actionCk: check(
      "self_healing_remediations_action_ck",
      sql`${t.action} IS NULL OR ${t.action} IN ('restart','rollback','scale_up','escalate','none')`,
    ),
    reversibilityCk: check(
      "self_healing_remediations_reversibility_ck",
      sql`${t.reversibility} IS NULL OR ${t.reversibility} IN ('reversible','cheap','irreversible')`,
    ),
  }),
);
