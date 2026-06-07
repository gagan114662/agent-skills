/**
 * Auto-routing selection (#14, ADR-0014). Pure + unit-tested: given the eligible agents
 * for a task's labels and their current open-task load, pick where the work goes.
 *
 * The repository decides *who is eligible* (rule labels ∩ task labels, active agents only)
 * and counts each one's open tasks; this function does the round-robin choice. Splitting it
 * out keeps the selection policy testable without a database.
 */
export interface RouteCandidate {
  memberId: string;
  /** Count of the candidate's non-terminal (open) tasks — lower wins. */
  openTasks: number;
}

/**
 * The least-loaded eligible agent (round-robin by load), ties broken deterministically by
 * member id ascending so the choice is reproducible. `null` when no one is eligible.
 */
export function selectLeastLoaded(candidates: RouteCandidate[]): string | null {
  let best: RouteCandidate | null = null;
  for (const c of candidates) {
    if (
      best === null ||
      c.openTasks < best.openTasks ||
      (c.openTasks === best.openTasks && c.memberId < best.memberId)
    ) {
      best = c;
    }
  }
  return best?.memberId ?? null;
}
