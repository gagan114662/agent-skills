import { pgTable, uuid, text, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { members } from "./identities.js";
import type { ScheduleSpec } from "../../automations/types.js";

/**
 * Automations persistence (#147, ADR-0147). Two workspace-scoped tables mirroring the watchdog/flywheel
 * definition+ledger split:
 *
 *  - `automations` — the owner's declaration: a trigger (schedule cadence or webhook token), a task
 *    template + params, a target channel, and the #123 department persona to run as. `enabled` is
 *    default false (creating one never fires until opted in); `next_run_at` is the scheduler cursor.
 *  - `automation_runs` — the durable run ledger feeding the audit trail. `session_id` is a **soft
 *    reference** (no FK) so a run outlives a pruned session; only `workspace_id`/`automation_id` carry
 *    the cascade.
 */

export const TRIGGER_KINDS = ["schedule", "webhook"] as const;
export const RUN_TRIGGERS = ["schedule", "webhook", "manual"] as const;
export const RUN_STATUSES = ["launched", "skipped", "blocked", "failed"] as const;

export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    triggerKind: text("trigger_kind", { enum: TRIGGER_KINDS }).notNull(),
    /** The cadence spec for a `schedule` trigger (null for `webhook`). */
    schedule: jsonb("schedule").$type<ScheduleSpec | null>(),
    /** sha-256 of the one-shown webhook token (null for `schedule`). Never store the token itself. */
    webhookTokenHash: text("webhook_token_hash"),
    templateKey: text("template_key").notNull(),
    params: jsonb("params").$type<Record<string, string>>().notNull().default({}),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** The #123 department persona handle the run launches as. */
    agentHandle: text("agent_handle").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    createdByMemberId: uuid("created_by_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** The scheduler cursor: the next time a `schedule` automation is due (null for webhook). */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("automations_workspace_idx").on(t.workspaceId),
    byDue: index("automations_due_idx").on(t.enabled, t.nextRunAt),
  }),
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    trigger: text("trigger", { enum: RUN_TRIGGERS }).notNull(),
    status: text("status", { enum: RUN_STATUSES }).notNull(),
    reason: text("reason").notNull().default(""),
    /** The launched session (soft reference), or null for a skipped/blocked run. */
    sessionId: uuid("session_id"),
    task: text("task").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceCreated: index("automation_runs_workspace_created_idx").on(t.workspaceId, t.createdAt),
    byAutomation: index("automation_runs_automation_idx").on(t.automationId),
  }),
);
