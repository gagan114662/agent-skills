import { pgTable, uuid, text, timestamp, jsonb, index, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";

/**
 * Linear-style tasks (issue #14, ADR-0014). Extends the #2 `tasks` stub additively
 * (description / labels / updated_at + a status CHECK) and adds the coordination tables
 * around it. Humans and agents are interchangeable assignees (members, ADR-0002 §5).
 */
export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "done",
  "canceled",
] as const;

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("backlog"),
    labels: jsonb("labels").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    assigneeMemberId: uuid("assignee_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStatus: index("tasks_workspace_status_idx").on(t.workspaceId, t.status),
    byAssignee: index("tasks_workspace_assignee_idx").on(t.workspaceId, t.assigneeMemberId),
    statusCk: check("tasks_status_ck", sql`${t.status} IN ('backlog','todo','in_progress','blocked','done','canceled')`),
  }),
);

/**
 * Append-only audit log of everything that happens to a task. Assignment/status history
 * is *derived* from these rows, so reassignment never loses the chain (ADR-0014).
 */
export const TASK_EVENT_TYPES = [
  "created",
  "status_changed",
  "assigned",
  "reassigned",
  "unassigned",
  "handoff",
  "linked",
  "unlinked",
  "dependency_added",
  "dependency_removed",
] as const;

export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type", { enum: TASK_EVENT_TYPES }).notNull(),
    actorMemberId: uuid("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTask: index("task_events_task_created_idx").on(t.taskId, t.createdAt),
  }),
);

/**
 * Polymorphic links from a task to another workspace object. #14 supports `message` and
 * `memory` targets (both validated in-workspace); `file` joins when a files table exists.
 * Resolves both ways — forward by task, reverse by (target_type, target_id).
 */
export const taskLinks = pgTable(
  "task_links",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique("task_links_task_target_uniq").on(t.taskId, t.targetType, t.targetId),
    reverse: index("task_links_reverse_idx").on(t.workspaceId, t.targetType, t.targetId),
  }),
);

/**
 * Task-to-task dependencies (#515). An edge `(blocked, blocker)` reads "blocked depends on blocker"
 * / "blocker blocks blocked" — the blocked task can't start until the blocker is terminal. The graph
 * is kept acyclic in the repository (cycle guard) before insert; the UNIQUE makes adding idempotent
 * and the CHECK forbids self-edges. Both tasks are workspace-scoped (validated at the route/repo).
 */
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    blockedTaskId: uuid("blocked_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    blockerTaskId: uuid("blocker_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique("task_dependencies_uniq").on(t.blockedTaskId, t.blockerTaskId),
    noSelf: check("task_dependencies_no_self", sql`${t.blockedTaskId} <> ${t.blockerTaskId}`),
    byBlocked: index("task_dependencies_blocked_idx").on(t.blockedTaskId),
    byBlocker: index("task_dependencies_blocker_idx").on(t.blockerTaskId),
    byWorkspace: index("task_dependencies_workspace_idx").on(t.workspaceId),
  }),
);

/**
 * Auto-routing rules: a label → an eligible agent member. The label is the capability/role;
 * routing collects every rule whose label matches a task's labels, then round-robins
 * (least-loaded) across the eligible agents (ADR-0014).
 */
export const taskRoutingRules = pgTable(
  "task_routing_rules",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    agentMemberId: uuid("agent_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique("task_routing_rules_uniq").on(t.workspaceId, t.label, t.agentMemberId),
    byLabel: index("task_routing_rules_label_idx").on(t.workspaceId, t.label),
  }),
);
