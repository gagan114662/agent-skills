import type { TaskStatus } from "./status.js";

export type NorthStarMetric = "revenue" | "activation";

export interface GoalAlignment {
  metric: NorthStarMetric | null;
  flagged: boolean;
  reason: string;
}

const ACTIVE_STATUSES = new Set<TaskStatus>(["todo", "in_progress", "blocked"]);

const REVENUE_TERMS = [
  "revenue",
  "paid",
  "paying",
  "payment",
  "checkout",
  "pricing",
  "price",
  "prospect",
  "customer",
  "conversion",
  "convert",
  "sales",
  "deal",
  "invoice",
  "stripe",
  "trial-to-paid",
] as const;

const ACTIVATION_TERMS = [
  "activation",
  "activate",
  "signup",
  "sign-up",
  "onboarding",
  "first-run",
  "first run",
  "magic moment",
  "new user",
  "workspace setup",
  "trial",
  "retention",
  "habit",
] as const;

function haystack(input: { title: string; description: string | null; labels: string[] }): string {
  return [input.title, input.description ?? "", ...input.labels].join(" ").toLowerCase();
}

function hasAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

/**
 * #631 goal-alignment check. Every active task should name the north-star metric it is meant to move.
 * This is deliberately deterministic and read-time derived from task data, so existing rows need no migration.
 */
export function assessGoalAlignment(input: {
  title: string;
  description: string | null;
  labels: string[];
  status: TaskStatus;
}): GoalAlignment {
  const text = haystack(input);
  const revenue = hasAny(text, REVENUE_TERMS);
  const activation = hasAny(text, ACTIVATION_TERMS);

  const metric: NorthStarMetric | null = revenue ? "revenue" : activation ? "activation" : null;
  if (metric) {
    return { metric, flagged: false, reason: `targets ${metric}` };
  }

  const flagged = ACTIVE_STATUSES.has(input.status);
  return {
    metric: null,
    flagged,
    reason: flagged
      ? "active task has no explicit revenue or activation target"
      : "no revenue or activation target named yet",
  };
}
