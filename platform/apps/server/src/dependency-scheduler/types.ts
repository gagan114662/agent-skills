/**
 * Shared types for the dependency-aware scheduler (issue #590).
 *
 * The problem: distribution agents (publish / send / post) can fire before the content they distribute has
 * passed review, brand-check, or human approval — risking junk going public. This module gives the orchestrator
 * a deterministic scheduling step: every downstream task declares the upstream *gates* it depends on, and an
 * outbound task is never eligible to execute until ALL of those gates are satisfied (approved). The dependency
 * is a first-class field on the task, so it is visible wherever the task is shown (#590 acceptance).
 *
 * Everything here is plain data. The pure planner in `plan.ts` reads only these structural fields — the task
 * kind, status, and the `dependsOn` id list — never any free-text label, so a poisoned task label can never make
 * a blocked outbound task look runnable (#200 §6 trust boundary).
 */

/**
 * The kind of work a task performs. Kinds drive two structural behaviours and nothing else:
 *  - GATE kinds ("review", "brand_check", "approval") guard content: a dependency on a gate is satisfied ONLY
 *    when that gate is `approved` (a gate that is merely `completed` does not clear its dependents).
 *  - OUTBOUND kinds ("publish", "send", "post", "distribute") are the irreversible public actions #590 protects.
 *    With `requireGateForOutbound` on (the default), an outbound task is fail-closed BLOCKED unless it depends on
 *    at least one gate — so forgetting the dependency can never let distribution slip out ungated.
 * Everything else ("draft", "generate", "task") is ordinary work whose dependency is satisfied when `completed`.
 */
export type TaskKind =
  | "review"
  | "brand_check"
  | "approval"
  | "draft"
  | "generate"
  | "publish"
  | "send"
  | "post"
  | "distribute"
  | "task";

/**
 * Lifecycle of a scheduled task.
 *   pending    — declared, not yet started. The only status from which a task can become runnable.
 *   running    — claimed and executing now.
 *   completed  — ordinary (non-gate) work finished successfully; SATISFIES its dependents.
 *   approved   — a gate passed review/brand/approval; SATISFIES its dependents.
 *   rejected   — a gate failed review; permanently BLOCKS its dependents (content must not go out).
 *   failed     — a task errored; permanently BLOCKS its dependents.
 *   cancelled  — a task was abandoned; permanently BLOCKS its dependents.
 */
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "approved"
  | "rejected"
  | "failed"
  | "cancelled";

/** A single unit of work in a workspace's dependency graph. */
export interface ScheduledTask {
  /** Stable id, unique within the workspace. */
  id: string;
  workspaceId: string;
  kind: TaskKind;
  status: TaskStatus;
  /**
   * Ids of the upstream tasks that must be satisfied before this task may run. This is the visible "dependency
   * on the task" the acceptance criterion calls for. For an outbound task this list includes the content gate(s).
   */
  dependsOn: string[];
  /** Groups the tasks that make up one piece of work (a content → review → publish chain). Optional. */
  objectiveId?: string | null;
  /** Human label shown in queues. NEVER read by the planner — purely presentational. */
  label?: string | null;
  /** Higher runs first among simultaneously-runnable tasks; ties fall back to id. Default 0. */
  priority?: number | null;
}

/** Why a pending task is not (yet) runnable. */
export type BlockReason =
  /** One or more upstream tasks are still pending/running — may become runnable later. */
  | "waiting_on_upstream"
  /** An upstream task is rejected/failed/cancelled — this branch can never run. */
  | "upstream_failed"
  /** A declared dependency id does not exist in the workspace — fail-closed, never runs. */
  | "missing_dependency"
  /** This task participates in a dependency cycle — unschedulable, never runs. */
  | "dependency_cycle"
  /** An outbound task declares no gate dependency while `requireGateForOutbound` is on — fail-closed. */
  | "ungated_outbound";

/** A pending task that is held back, with the exact reason and the upstream ids responsible. */
export interface BlockedTask {
  taskId: string;
  reason: BlockReason;
  /** The specific upstream task ids that caused the block (empty for cycle/ungated where the task itself is at fault). */
  blockedBy: string[];
  /** True when no future state change can unblock it (dead branch: failed/missing/cycle/ungated). */
  permanent: boolean;
}

/**
 * The deterministic result of planning a workspace's task graph. Pure function of the task set — same input
 * always yields the same plan, which is what makes "no outbound action runs before its gate" auditable.
 */
export interface SchedulePlan {
  /** Task ids eligible to execute NOW (all dependencies satisfied), best-first deterministic order. */
  runnable: string[];
  /** Pending tasks held back, deterministic order. */
  blocked: BlockedTask[];
  /** Task ids already satisfied (completed/approved). */
  done: string[];
  /** Task ids in a terminal-bad state (rejected/failed/cancelled). */
  failed: string[];
  /** Task ids that participate in at least one dependency cycle. */
  cyclic: string[];
}
