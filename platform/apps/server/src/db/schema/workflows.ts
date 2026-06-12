import { pgTable, uuid, text, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import type { WorkflowTrigger, WorkflowCondition, WorkflowAction, WorkflowActionResult } from "../../workflows/types.js";

/**
 * Workflow builder persistence (#152, ADR-0152). The generalization of #147 automations: a workflow is
 * a trigger → conditions → actions chain stored as data, so a pure evaluator decides firings and the
 * engine reuses existing task/approval paths. Two workspace-scoped tables mirroring the automations
 * definition+ledger split:
 *
 *  - `workflows` — the owner's declaration: a trigger (its kind + config in `trigger` jsonb), an
 *    AND-list of pure `conditions`, and an ordered `actions` list. `enabled` is default false (creating
 *    one never fires until opted in); `next_run_at` is the scheduler cursor for a `schedule` trigger.
 *  - `workflow_runs` — the durable run ledger feeding the console trends + the #117 flywheel. `results`
 *    records the per-action outcome bundle (kinds, statuses, reference ids — never secrets).
 */

export const WORKFLOW_TRIGGER_KINDS = ["schedule", "webhook", "catalog_change", "channel_event"] as const;
export const WORKFLOW_RUN_TRIGGERS = [
  "schedule",
  "webhook",
  "catalog_change",
  "channel_event",
  "manual",
] as const;
export const WORKFLOW_RUN_STATUSES = ["fired", "skipped", "blocked", "failed"] as const;

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    triggerKind: text("trigger_kind", { enum: WORKFLOW_TRIGGER_KINDS }).notNull(),
    /** The trigger config: schedule cadence / catalog kind filter / channel id, keyed by kind. */
    trigger: jsonb("trigger").$type<WorkflowTrigger>().notNull().default({ kind: "schedule" }),
    /** The AND-list of pure predicates evaluated against the facts bag. */
    conditions: jsonb("conditions").$type<WorkflowCondition[]>().notNull().default([]),
    /** The ordered action list executed when the workflow fires. */
    actions: jsonb("actions").$type<WorkflowAction[]>().notNull().default([]),
    /** sha-256 of the one-shown webhook token (null unless the trigger is `webhook`). */
    webhookTokenHash: text("webhook_token_hash"),
    enabled: boolean("enabled").notNull().default(false),
    createdByMemberId: uuid("created_by_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    /** The scheduler cursor: the next time a `schedule` workflow is due (null otherwise). */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("workflows_workspace_idx").on(t.workspaceId),
    byDue: index("workflows_due_idx").on(t.enabled, t.nextRunAt),
  }),
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    trigger: text("trigger", { enum: WORKFLOW_RUN_TRIGGERS }).notNull(),
    status: text("status", { enum: WORKFLOW_RUN_STATUSES }).notNull(),
    reason: text("reason").notNull().default(""),
    /** The per-action outcome bundle (kinds + statuses + reference ids; never secrets). */
    results: jsonb("results").$type<WorkflowActionResult[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceCreated: index("workflow_runs_workspace_created_idx").on(t.workspaceId, t.createdAt),
    byWorkflow: index("workflow_runs_workflow_idx").on(t.workflowId),
  }),
);
