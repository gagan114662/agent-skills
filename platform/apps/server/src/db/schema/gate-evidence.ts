import { pgTable, uuid, text, integer, doublePrecision, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";

/**
 * Evidence-Priced Autonomy storage (issue #119, ADR-0119). Two additive, **append-only** tables; no
 * existing table is touched. `gate_evidence` records every terminal human decision outcome per approval
 * action class (the signal the pricer reads); `gate_boundary_changes` records every RELAX/RETIGHTEN the
 * pricer applies (the #13-style audit + the Founder Console history source).
 */

/** Decision outcomes recorded as evidence. `edited` = the human corrected the agent's draft before approving. */
export const GATE_EVIDENCE_OUTCOMES = ["approved", "rejected", "edited"] as const;

/**
 * One terminal human decision, recorded in the same transaction as the #13 decision so it can never
 * drift from `approval_events`. `request_id` is a **soft reference** (no FK) so evidence outlives a
 * pruned request; only `workspace_id` carries the #3 tenant boundary. `edit_distance` is set only for an
 * `edited` outcome on drafted content; `time_to_decision_ms` is `decided_at − created_at`.
 */
export const gateEvidence = pgTable(
  "gate_evidence",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(),
    outcome: text("outcome", { enum: GATE_EVIDENCE_OUTCOMES }).notNull(),
    editDistance: integer("edit_distance"),
    timeToDecisionMs: integer("time_to_decision_ms").notNull(),
    requestId: uuid("request_id"),
    decidedByMemberId: uuid("decided_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The trailing-window read is "last N decisions for (workspace, action_type)".
    byActionCreated: index("gate_evidence_action_created_idx").on(
      t.workspaceId,
      t.actionType,
      t.createdAt,
    ),
    outcomeCk: check("gate_evidence_outcome_ck", sql`${t.outcome} IN ('approved','rejected','edited')`),
  }),
);

/** The direction a boundary moved. */
export const GATE_BOUNDARY_DIRECTIONS = ["RELAX", "RETIGHTEN"] as const;

/**
 * One boundary change the pricer applied — the append-only audit of every human/AI-split move. Carries
 * the **measured error rate that earned it**, the window size, the affected #95 `approval_policies` rule
 * (`policy_rule_id`, a soft ref — the rule may later be revoked), and the reason. Never updated/deleted.
 */
export const gateBoundaryChanges = pgTable(
  "gate_boundary_changes",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(),
    direction: text("direction", { enum: GATE_BOUNDARY_DIRECTIONS }).notNull(),
    errorRate: doublePrecision("error_rate").notNull(),
    windowSize: integer("window_size").notNull(),
    policyRuleId: uuid("policy_rule_id"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCreated: index("gate_boundary_changes_workspace_created_idx").on(t.workspaceId, t.createdAt),
    directionCk: check(
      "gate_boundary_changes_direction_ck",
      sql`${t.direction} IN ('RELAX','RETIGHTEN')`,
    ),
  }),
);
