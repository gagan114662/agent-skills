import type { TaskStatus } from "../tasks/status.js";
import { loopGuardTripped } from "./guards.js";

/**
 * The autonomy decision (#17, ADR-0017 §4-5). Pure + unit-tested: given a workflow's state, its
 * task's status, and the guard signals, decide the **single** next action the engine should apply
 * this tick. One action per workflow per tick keeps progression observable and the guards
 * meaningful. The engine does the side effects; this function does the choice.
 */
export type AutonomyAction = "start" | "handoff" | "request_approval" | "timeout_approval" | "noop";

export type WorkflowStatus = "running" | "awaiting_approval" | "completed" | "canceled";

export interface WorkflowState {
  status: WorkflowStatus;
  /** Index of the active stage in the pipeline. */
  currentStage: number;
  /** Number of stages in the pipeline. */
  stageCount: number;
  /** Autonomous actions already taken on this workflow (loop-guard input). */
  actionCount: number;
  /** True when an approval-gated workflow has exceeded its disclosed SLA/deadline. */
  approvalOverdue?: boolean;
}

export interface DecisionInput {
  task: { status: TaskStatus };
  workflow: WorkflowState;
  /** Workspace kill switch — authoritative; halts immediately. */
  killSwitch: boolean;
  /** Cost guard: the acting agent has exhausted its action budget. */
  budgetExhausted: boolean;
  /** Loop-guard ceiling override (defaults to {@link DEFAULT_LOOP_GUARD_MAX}). */
  loopGuardMax?: number;
}

export interface AutonomyDecision {
  action: AutonomyAction;
  /** Why — surfaced in logs/metrics and asserted in tests. */
  reason: string;
}

const noop = (reason: string): AutonomyDecision => ({ action: "noop", reason });

/**
 * Decide the next action. Order matters: the kill switch and guards win over any progress, then a
 * non-running workflow is inert, then the task's status drives start → handoff → approval.
 */
export function decideWorkflowAction(input: DecisionInput): AutonomyDecision {
  const { task, workflow, killSwitch, budgetExhausted, loopGuardMax } = input;

  if (killSwitch) return noop("kill_switch");
  if (budgetExhausted) return noop("budget_exhausted");
  if (loopGuardTripped(workflow.actionCount, loopGuardMax)) return noop("loop_guard");

  if (workflow.status === "awaiting_approval" && workflow.approvalOverdue) {
    return { action: "timeout_approval", reason: "approval_deadline_exceeded" };
  }
  if (workflow.status !== "running") return noop(`workflow_${workflow.status}`);
  if (workflow.stageCount === 0) return noop("no_stages");

  switch (task.status) {
    case "backlog":
    case "todo":
      return { action: "start", reason: "task_unstarted" };
    case "in_progress":
      return workflow.currentStage < workflow.stageCount - 1
        ? { action: "handoff", reason: "more_stages" }
        : { action: "request_approval", reason: "final_stage" };
    case "blocked":
      return noop("task_blocked");
    case "done":
    case "canceled":
      return noop("task_terminal");
    default:
      return noop("no_action");
  }
}
