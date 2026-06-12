/**
 * Shared types for the Visual Workflow Builder (#152, ADR-0152). A workflow is a data-driven
 * trigger → conditions → actions chain — the generalization of #147 automations. The pure `conditions`
 * / `decide` / `caps` / `insights` modules and the IO `engine` agree on these. The model is small and
 * declarative so the console can render + edit it and a pure evaluator can decide firings.
 */
import type { ScheduleSpec } from "../automations/types.js";
import type { CatalogKind } from "../catalog/types.js";
import type { MarketingSendKind } from "../marketing/external-send.js";

// ---- triggers -----------------------------------------------------------------------------------

/**
 * How a workflow fires:
 *  - `schedule`       — cursor-driven (`next_run_at`), reusing the #147 `computeNextRun` seam.
 *  - `webhook`        — token-driven (a bearer POST), like an automation webhook.
 *  - `catalog_change` — fired when a catalog entry (optionally of `catalogKind`) changes.
 *  - `channel_event`  — fired by an event in `channelId` (the engine exposes the seam; wiring is opt-in).
 */
export const WORKFLOW_TRIGGER_KINDS = ["schedule", "webhook", "catalog_change", "channel_event"] as const;
export type WorkflowTriggerKind = (typeof WORKFLOW_TRIGGER_KINDS)[number];

export function isWorkflowTriggerKind(value: unknown): value is WorkflowTriggerKind {
  return typeof value === "string" && (WORKFLOW_TRIGGER_KINDS as readonly string[]).includes(value);
}

/** The trigger config (stored as `workflows.trigger` jsonb). Only the fields a kind uses are read. */
export interface WorkflowTrigger {
  kind: WorkflowTriggerKind;
  /** `schedule` trigger: the cadence spec (reuses #147 `ScheduleSpec`). */
  schedule?: ScheduleSpec;
  /** `catalog_change` trigger: only fire when an entry of this kind changes (absent = any kind). */
  catalogKind?: CatalogKind;
  /** `channel_event` trigger: the channel whose events fire this workflow. */
  channelId?: string;
}

// ---- conditions ---------------------------------------------------------------------------------

/** The comparison operators a condition predicate supports. */
export const CONDITION_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export function isConditionOp(value: unknown): value is ConditionOp {
  return typeof value === "string" && (CONDITION_OPS as readonly string[]).includes(value);
}

/**
 * One pure predicate over the facts bag. `fact` is a dot-path (e.g. `catalog.site.status`,
 * `metrics.signups`); `op` compares the resolved value against `value`. `exists` needs no `value`.
 * Conditions on a workflow are ANDed (all must hold for the workflow to fire).
 */
export interface WorkflowCondition {
  fact: string;
  op: ConditionOp;
  value?: string | number | boolean;
}

/** The bag of facts a condition is evaluated against (catalog rollups + metrics + trigger context). */
export type WorkflowFacts = Record<string, unknown>;

// ---- actions ------------------------------------------------------------------------------------

/**
 * What a fired workflow does. NONE introduce new egress:
 *  - `agent_task`   — launch a #123 draft-only persona through the SAME #96/#71-gated launcher
 *                     automations use (any external send the agent drafts still leaves via #13).
 *  - `draft_send`   — submit an `external.send` to the #13 gate as a PENDING approval (never a send).
 *  - `notify_owner` — write an in-app notification to the workspace owner.
 */
export const WORKFLOW_ACTION_KINDS = ["agent_task", "draft_send", "notify_owner"] as const;
export type WorkflowActionKind = (typeof WORKFLOW_ACTION_KINDS)[number];

export function isWorkflowActionKind(value: unknown): value is WorkflowActionKind {
  return typeof value === "string" && (WORKFLOW_ACTION_KINDS as readonly string[]).includes(value);
}

export interface WorkflowAction {
  kind: WorkflowActionKind;
  // agent_task ---------------------------------------------------------------------------------
  /** The channel the launched agent posts into. */
  channelId?: string;
  /** The #123 department persona handle to launch as (else derived from the channel department). */
  agentHandle?: string;
  /** A task template key (reuses the #147 gallery) the run renders. */
  templateKey?: string;
  /** Flat params substituted into the template body. */
  params?: Record<string, string>;
  /** A literal task body (used when no `templateKey` is given). */
  task?: string;
  // draft_send ---------------------------------------------------------------------------------
  /** The outbound send kind (`social.post` / `email.send` / `ad.spend`) the #13 gate receives. */
  sendKind?: MarketingSendKind;
  /** The one-line review-queue summary of what would go out. */
  summary?: string;
  /** Optional target (handle / list / campaign). */
  target?: string;
  /** Ad spend in cents (threaded as the #13 action amount so the spend-threshold gate can re-gate). */
  amountCents?: number;
  // notify_owner -------------------------------------------------------------------------------
  /** The notification body. */
  message?: string;
}

/** The status of a single executed action. */
export const ACTION_STATUSES = ["ok", "blocked", "failed"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** The recorded outcome of one action (stored in `workflow_runs.results`; never holds secrets). */
export interface WorkflowActionResult {
  kind: WorkflowActionKind;
  status: ActionStatus;
  reason: string;
  /** A reference id the action produced (session id / approval request id / notification id). */
  ref?: string;
}

// ---- records ------------------------------------------------------------------------------------

export interface WorkflowRecord {
  id: string;
  workspaceId: string;
  name: string;
  triggerKind: WorkflowTriggerKind;
  trigger: WorkflowTrigger;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  enabled: boolean;
  createdByMemberId: string;
  lastFiredAt: Date | null;
  /** The scheduler cursor (null unless the trigger is `schedule`). */
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What actually caused a run (a manual "run now" is distinct from the scheduler / webhook / event). */
export const WORKFLOW_RUN_TRIGGERS = [
  "schedule",
  "webhook",
  "catalog_change",
  "channel_event",
  "manual",
] as const;
export type WorkflowRunTrigger = (typeof WORKFLOW_RUN_TRIGGERS)[number];

/** The outcome of a run attempt (the durable `workflow_runs.status`). */
export const WORKFLOW_RUN_STATUSES = ["fired", "skipped", "blocked", "failed"] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export interface WorkflowRun {
  id: string;
  workspaceId: string;
  workflowId: string;
  trigger: WorkflowRunTrigger;
  status: WorkflowRunStatus;
  reason: string;
  results: WorkflowActionResult[];
  createdAt: Date;
}

// ---- decision -----------------------------------------------------------------------------------

/** The pure run decision input — every async fact the engine resolved up front. */
export interface WorkflowRunDecisionInput {
  /** The per-tenant workflows flag (config; default OFF). */
  capsEnabled: boolean;
  /** This workflow's own `enabled` flag. */
  workflowEnabled: boolean;
  /** The #17 kill switch for the workspace. */
  killSwitch: boolean;
  /** Whether the trigger is due (scheduler: `next_run_at <= now`; manual/webhook/event: always true). */
  due: boolean;
  /** Whether all conditions held against the facts bag. */
  conditionsMet: boolean;
  /** Runs recorded for this workspace inside the rate window. */
  runsInWindow: number;
  /** The per-tenant cap on firings per window. */
  maxRunsPerWindow: number;
}

export type WorkflowRunAction = "run" | "skip";

export interface WorkflowRunDecision {
  action: WorkflowRunAction;
  reason: string;
}
