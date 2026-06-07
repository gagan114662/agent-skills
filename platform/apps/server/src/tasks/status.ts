import { TASK_STATUSES } from "../db/schema/tasks.js";

/**
 * Task status lifecycle (#14, ADR-0014). Pure + unit-tested so transitions are validated
 * the same way everywhere; the DB CHECK constraint is the matching edge guard.
 */
export const STATUSES = TASK_STATUSES;
export type TaskStatus = (typeof STATUSES)[number];

/**
 * Allowed forward/back transitions. `done`/`canceled` are terminal except for an explicit
 * reopen to `todo`. Same-status is intentionally absent → a no-op transition is rejected.
 */
const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ["todo", "in_progress", "canceled"],
  todo: ["in_progress", "backlog", "canceled"],
  in_progress: ["blocked", "done", "todo", "canceled"],
  blocked: ["in_progress", "canceled"],
  done: ["todo"],
  canceled: ["todo"],
};

/** Type guard: is `s` one of the lifecycle statuses? */
export function isStatus(s: string): s is TaskStatus {
  return (STATUSES as readonly string[]).includes(s);
}

/** True when moving from `from` to `to` is a permitted, non-no-op transition. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from].includes(to);
}
