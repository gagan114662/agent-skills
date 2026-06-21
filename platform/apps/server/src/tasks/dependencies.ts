import type { TaskStatus } from "./status.js";

/**
 * Pure dependency logic (#515, ADR-0014). Tasks form a *blocks* graph: a task may depend on
 * (be blocked by) other tasks in the same workspace, and cannot start until its blockers finish.
 * The DAG guard and the blocker-satisfaction predicate live here so they are validated the same
 * way everywhere; the DB UNIQUE constraint and the in-workspace checks are the matching edge guards.
 *
 * Direction convention: an edge is `(blockedTask depends on blockerTask)` — the blocker must reach
 * a terminal state before the blocked task may move into `in_progress`.
 */

/** A blocker no longer holds work back once it is terminal (shipped or abandoned). */
const SATISFIED: readonly TaskStatus[] = ["done", "canceled"];

/** True once a blocker task can no longer hold its dependents back. */
export function isBlockerSatisfied(status: TaskStatus): boolean {
  return SATISFIED.includes(status);
}

/** How many of a task's blockers are still open (the count the start-guard rejects on). */
export function unsatisfiedBlockerCount(blockerStatuses: TaskStatus[]): number {
  return blockerStatuses.filter((s) => !isBlockerSatisfied(s)).length;
}

/**
 * Would adding `blockedTaskId depends on blockerTaskId` create a cycle in the existing graph?
 *
 * `dependsOn` is the current adjacency: `dependsOn.get(x)` = the tasks x already depends on. Adding
 * the new edge closes a loop iff `blockerTaskId` can already reach `blockedTaskId` by following
 * depends-on edges (or the edge is a self-loop). Kept pure + iterative (explicit stack) so an
 * adversarial chain can't blow the call stack.
 */
export function wouldCreateCycle(
  dependsOn: Map<string, string[]>,
  blockedTaskId: string,
  blockerTaskId: string,
): boolean {
  if (blockedTaskId === blockerTaskId) return true;
  const seen = new Set<string>();
  const stack = [blockerTaskId];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === blockedTaskId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of dependsOn.get(node) ?? []) stack.push(next);
  }
  return false;
}
