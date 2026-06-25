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
import { channels } from "./channels.js";
import { members } from "./identities.js";
import { tasks } from "./tasks.js";
import { agentSessions } from "./agent-sessions.js";

/**
 * Cross-team agent pooling + autonomy (issue #17, ADR-0017). All tables are workspace-scoped:
 * "cross-team" means cross-channel **within** a workspace — the #3 tenant boundary is never
 * crossed. These extend #9 (RBAC), #14 (tasks), #16 (shared memory) and #25 (server-owned runs)
 * rather than reinventing them.
 */

/** A named, discoverable pool of agents in a workspace. Pooled agents are shareable into channels. */
export const agentPools = pgTable(
  "agent_pools",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameUniq: unique("agent_pools_workspace_name_uniq").on(t.workspaceId, t.name),
  }),
);

/**
 * Membership of an agent in a pool, with the **roles** (capability labels) it fills. Roles describe
 * *what* the agent does; #9 capabilities enforce *whether* it may — a workflow stage's role must be
 * one of the agent's pool roles.
 */
export const agentPoolMembers = pgTable(
  "agent_pool_members",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => agentPools.id, { onDelete: "cascade" }),
    agentMemberId: uuid("agent_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    roles: jsonb("roles").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique("agent_pool_members_uniq").on(t.poolId, t.agentMemberId),
    byAgent: index("agent_pool_members_agent_idx").on(t.workspaceId, t.agentMemberId),
  }),
);

/**
 * Per-agent autonomy configuration + the rate/cost guard state. `enabled` defaults false — autonomy
 * is off until explicitly turned on. `maxActionsPerTick` is the rate guard; `actionBudget` /
 * `actionsUsed` are the cost guard (an action-budget proxy for spend, ADR-0017 §8).
 */
export const agentAutonomy = pgTable(
  "agent_autonomy",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentMemberId: uuid("agent_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    maxActionsPerTick: integer("max_actions_per_tick").notNull().default(5),
    actionBudget: integer("action_budget").notNull().default(100),
    actionsUsed: integer("actions_used").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique("agent_autonomy_workspace_agent_uniq").on(t.workspaceId, t.agentMemberId),
  }),
);

/** Per-workspace autonomy control: the kill switch that halts every agent at once (ADR-0017 §8). */
export const autonomyControls = pgTable("autonomy_controls", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  killSwitch: boolean("kill_switch").notNull().default(false),
  updatedByMemberId: uuid("updated_by_member_id").references(() => members.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An autonomous workflow: a linear pipeline of **stages** over a #14 task, narrated into a channel
 * (the "team"). `currentStage` points at the active stage; `actionCount` is the loop guard; status
 * parks at `awaiting_approval` for the human gate (ADR-0017 §5).
 */
export const WORKFLOW_STATUSES = ["running", "awaiting_approval", "completed", "canceled"] as const;

export const agentWorkflows = pgTable(
  "agent_workflows",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    stages: jsonb("stages")
      .$type<{ agentMemberId: string; role: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    currentStage: integer("current_stage").notNull().default(0),
    status: text("status", { enum: WORKFLOW_STATUSES }).notNull().default("running"),
    actionCount: integer("action_count").notNull().default(0),
    currentSessionId: uuid("current_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    currentSessionStage: integer("current_session_stage"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskUniq: unique("agent_workflows_task_uniq").on(t.taskId),
    byStatus: index("agent_workflows_workspace_status_idx").on(t.workspaceId, t.status),
    statusCk: check(
      "agent_workflows_status_ck",
      sql`${t.status} IN ('running','awaiting_approval','completed','canceled')`,
    ),
  }),
);

/**
 * An approval gate: the agent creates a pending row instead of completing the workflow; a human
 * decides. An agent can never self-approve — decision routes require a human identity (ADR-0017 §6).
 *
 * A decision is normally made by a human (`decision_source='human'`). The #84 follow-up (ADR-0042)
 * adds the policy path: when a workspace's `autonomy.complete` policy rule auto-approves, the engine
 * decides the gate itself (`decision_source='policy'`) and records which rule fired (`policy_rule_id`)
 * as the audit anchor — the human gate is preserved for every workspace without such a rule.
 */
export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export const APPROVAL_DECISION_SOURCES = ["human", "policy"] as const;

export const agentApprovals = pgTable(
  "agent_approvals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").references(() => agentWorkflows.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    requestedByMemberId: uuid("requested_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    status: text("status", { enum: APPROVAL_STATUSES }).notNull().default("pending"),
    decidedByMemberId: uuid("decided_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    /** Who closed the gate: a human reviewer, or an auto-approve policy rule (#84 follow-up). */
    decisionSource: text("decision_source", { enum: APPROVAL_DECISION_SOURCES })
      .notNull()
      .default("human"),
    /** The `approval_policies` rule that auto-approved this gate (audit), null for human decisions. */
    policyRuleId: uuid("policy_rule_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => ({
    byStatus: index("agent_approvals_workspace_status_idx").on(t.workspaceId, t.status),
    statusCk: check(
      "agent_approvals_status_ck",
      sql`${t.status} IN ('pending','approved','rejected')`,
    ),
    sourceCk: check(
      "agent_approvals_decision_source_ck",
      sql`${t.decisionSource} IN ('human','policy')`,
    ),
  }),
);
