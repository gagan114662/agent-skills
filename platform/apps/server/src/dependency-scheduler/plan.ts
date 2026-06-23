/**
 * The PURE planning core of issue #590. Given a workspace's task graph and the resolved
 * {@link DependencySchedulerCaps}, it deterministically partitions every task into runnable / blocked / done /
 * failed and detects dependency cycles. No IO, no clock, no randomness — the same task set always yields the same
 * plan, which is what makes "no outbound action runs before its gate" auditable and lets the service test the
 * guarantee without a database or real time.
 *
 * The single safety invariant, stated structurally:
 *   A pending task is RUNNABLE iff every dependency exists and is SATISFIED, it is not in a cycle, and (for an
 *   outbound task under `requireGateForOutbound`) it depends on at least one gate. A gate dependency is satisfied
 *   ONLY when the gate is `approved`. Therefore an outbound task can never be runnable while its content gate is
 *   still pending/running/rejected — distribution cannot precede approval.
 *
 * The core reads only structural fields (kind, status, the dependsOn id list) — never the free-text label — so a
 * crafted task label cannot steer scheduling (#200 §6).
 */

import type { DependencySchedulerCaps } from "./caps.js";
import { isGateKind, isOutboundKind, resolveDependencySchedulerCaps } from "./caps.js";
import type { BlockedTask, ScheduledTask, SchedulePlan, TaskStatus } from "./types.js";

/** Statuses that satisfy a NON-gate dependency. */
const SATISFYING_STATUSES: readonly TaskStatus[] = ["completed", "approved"];

/** Statuses that permanently kill a dependency (the downstream branch can never run). */
const DEAD_STATUSES: readonly TaskStatus[] = ["rejected", "failed", "cancelled"];

/**
 * Whether `task` satisfies a downstream dependency. A gate is satisfied ONLY by `approved` (a gate that merely
 * `completed` does not clear content); ordinary work is satisfied by `completed` or `approved`.
 */
export function isSatisfied(task: ScheduledTask): boolean {
  if (isGateKind(task.kind)) return task.status === "approved";
  return SATISFYING_STATUSES.includes(task.status);
}

/** Whether `task` is in a terminal-bad state that permanently blocks anything depending on it. */
export function isDead(task: ScheduledTask): boolean {
  return DEAD_STATUSES.includes(task.status);
}

/**
 * Find every task id that participates in a dependency cycle, via iterative DFS with white/grey/black colouring.
 * Self-dependencies (a task that lists its own id) count as a one-node cycle. Edges to missing ids are ignored
 * here (they are reported separately as `missing_dependency`).
 */
function findCyclicIds(tasks: ScheduledTask[], byId: Map<string, ScheduledTask>): Set<string> {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const t of tasks) colour.set(t.id, WHITE);
  const cyclic = new Set<string>();

  for (const root of tasks) {
    if (colour.get(root.id) !== WHITE) continue;
    // Explicit stack of (node, deps, index, onStack-path) so we never blow the call stack on deep graphs.
    const path: string[] = [];
    const stack: { id: string; deps: string[]; i: number }[] = [
      { id: root.id, deps: root.dependsOn, i: 0 },
    ];
    colour.set(root.id, GREY);
    path.push(root.id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.i < frame.deps.length) {
        const dep = frame.deps[frame.i]!;
        frame.i += 1;
        if (!byId.has(dep)) continue; // missing dep — not a cycle edge
        const c = colour.get(dep);
        if (c === GREY) {
          // Back-edge: every node on the current path from `dep` onward is in the cycle.
          const from = path.indexOf(dep);
          if (from >= 0) for (let k = from; k < path.length; k++) cyclic.add(path[k]!);
        } else if (c === WHITE) {
          const next = byId.get(dep)!;
          colour.set(dep, GREY);
          path.push(dep);
          stack.push({ id: dep, deps: next.dependsOn, i: 0 });
        }
      } else {
        colour.set(frame.id, BLACK);
        path.pop();
        stack.pop();
      }
    }
  }
  return cyclic;
}

/** Stable comparison for runnable tasks: higher priority first, then lexicographic id. */
function compareRunnable(a: ScheduledTask, b: ScheduledTask): number {
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  if (pb !== pa) return pb - pa;
  return a.id.localeCompare(b.id);
}

/**
 * Plan a workspace's task graph into the deterministic {@link SchedulePlan}.
 *
 * @param tasks all tasks under consideration. They should belong to one workspace (the service guarantees this);
 *              the planner itself is workspace-agnostic and simply treats `dependsOn` ids as references into this
 *              set. Duplicate ids are a programming error and throw.
 */
export function planSchedule(
  tasks: ScheduledTask[],
  caps: DependencySchedulerCaps = resolveDependencySchedulerCaps(),
): SchedulePlan {
  const byId = new Map<string, ScheduledTask>();
  for (const t of tasks) {
    if (byId.has(t.id)) throw new Error(`dependency-scheduler: duplicate task id "${t.id}"`);
    byId.set(t.id, t);
  }

  const cyclic = findCyclicIds(tasks, byId);

  const runnableTasks: ScheduledTask[] = [];
  const blocked: BlockedTask[] = [];
  const done: string[] = [];
  const failed: string[] = [];

  for (const task of tasks) {
    if (isDead(task)) {
      failed.push(task.id);
      continue;
    }
    if (task.status === "completed" || task.status === "approved") {
      done.push(task.id);
      continue;
    }
    // pending / running: only `pending` can ever become runnable; `running` is in flight, not eligible to start.
    if (task.status === "running") continue;

    // Cyclic tasks are unschedulable, fail-closed.
    if (cyclic.has(task.id)) {
      blocked.push({ taskId: task.id, reason: "dependency_cycle", blockedBy: [], permanent: true });
      continue;
    }

    const missing: string[] = [];
    const deadDeps: string[] = [];
    const waiting: string[] = [];
    let dependsOnGate = false;

    for (const depId of task.dependsOn) {
      const dep = byId.get(depId);
      if (!dep) {
        missing.push(depId);
        continue;
      }
      if (isGateKind(dep.kind)) dependsOnGate = true;
      if (isDead(dep)) deadDeps.push(depId);
      else if (!isSatisfied(dep)) waiting.push(depId);
    }

    // Fail-closed: an outbound task with no gate dependency must never run (forgotten gate guard).
    if (caps.requireGateForOutbound && isOutboundKind(task.kind) && !dependsOnGate) {
      blocked.push({ taskId: task.id, reason: "ungated_outbound", blockedBy: [], permanent: true });
      continue;
    }
    if (missing.length > 0) {
      blocked.push({ taskId: task.id, reason: "missing_dependency", blockedBy: missing, permanent: true });
      continue;
    }
    if (deadDeps.length > 0) {
      blocked.push({ taskId: task.id, reason: "upstream_failed", blockedBy: deadDeps, permanent: true });
      continue;
    }
    if (waiting.length > 0) {
      blocked.push({ taskId: task.id, reason: "waiting_on_upstream", blockedBy: waiting, permanent: false });
      continue;
    }
    runnableTasks.push(task);
  }

  runnableTasks.sort(compareRunnable);
  blocked.sort((a, b) => a.taskId.localeCompare(b.taskId));
  done.sort((a, b) => a.localeCompare(b));
  failed.sort((a, b) => a.localeCompare(b));

  return {
    runnable: runnableTasks.map((t) => t.id),
    blocked,
    done,
    failed,
    cyclic: [...cyclic].sort((a, b) => a.localeCompare(b)),
  };
}

/** The single best task to execute next, or null when nothing is runnable. */
export function nextRunnable(plan: SchedulePlan): string | null {
  return plan.runnable[0] ?? null;
}

/** Whether `taskId` is cleared to execute under `plan` — the structural "may distribute" check. */
export function isRunnable(plan: SchedulePlan, taskId: string): boolean {
  return plan.runnable.includes(taskId);
}
