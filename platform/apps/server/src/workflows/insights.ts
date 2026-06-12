import type { WorkflowRun, WorkflowRunStatus } from "./types.js";

/**
 * The pure run-history aggregator (#152, ADR-0152 §4) — incident.io's "Insights". Given a workspace's
 * recorded `workflow_runs`, it computes the success/failure trend the console renders. No IO, no clock
 * (`now` is injected for the per-day buckets), so it is fully unit-testable. The console reads this; the
 * #117 flywheel is fed separately by the engine on each `failed` run.
 */

export interface WorkflowInsights {
  total: number;
  byStatus: Record<WorkflowRunStatus, number>;
  /** fired / (fired + failed + blocked), 0..1 — skips (not-due/disabled) are excluded as non-attempts. */
  successRate: number;
  /** The most recent failure reasons (newest first, deduped), for the console's "recent failures" line. */
  recentFailureReasons: string[];
  /** Daily buckets (UTC `YYYY-MM-DD`) of fired vs failed, oldest first — the trend sparkline source. */
  daily: { date: string; fired: number; failed: number; blocked: number }[];
}

const STATUSES: WorkflowRunStatus[] = ["fired", "skipped", "blocked", "failed"];

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Aggregate runs into the console trend. `days` bounds the daily buckets (default 14). Runs are assumed
 * newest-first (the repo's order) but the function does not rely on it for the counts.
 */
export function aggregateWorkflowInsights(
  runs: WorkflowRun[],
  now: Date,
  days = 14,
): WorkflowInsights {
  const byStatus = { fired: 0, skipped: 0, blocked: 0, failed: 0 } as Record<WorkflowRunStatus, number>;
  for (const r of runs) {
    if (STATUSES.includes(r.status)) byStatus[r.status]++;
  }
  const attempts = byStatus.fired + byStatus.failed + byStatus.blocked;
  const successRate = attempts === 0 ? 0 : byStatus.fired / attempts;

  const recentFailureReasons: string[] = [];
  for (const r of runs) {
    if (r.status === "failed" && r.reason && !recentFailureReasons.includes(r.reason)) {
      recentFailureReasons.push(r.reason);
      if (recentFailureReasons.length >= 5) break;
    }
  }

  // Build empty day buckets [now-(days-1) .. now], then fill from the runs.
  const buckets = new Map<string, { fired: number; failed: number; blocked: number }>();
  const order: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = utcDay(d);
    buckets.set(key, { fired: 0, failed: 0, blocked: 0 });
    order.push(key);
  }
  for (const r of runs) {
    const key = utcDay(r.createdAt);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (r.status === "fired") bucket.fired++;
    else if (r.status === "failed") bucket.failed++;
    else if (r.status === "blocked") bucket.blocked++;
  }

  return {
    total: runs.length,
    byStatus,
    successRate,
    recentFailureReasons,
    daily: order.map((date) => ({ date, ...buckets.get(date)! })),
  };
}
