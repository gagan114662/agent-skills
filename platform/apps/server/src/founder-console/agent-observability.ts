import type { AgentTraceEventRow, AgentTraceRunRow } from "../db/repositories/agent-trace.js";
import type { WorkspaceLiveSession } from "../db/repositories/agent-sessions.js";
import type { SchedulerJobState } from "../scheduler/types.js";
import type { AgentObservabilityView } from "./aggregate.js";

const STALLED_RUN_AGE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function objectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAuditEnvelope(event: AgentTraceEventRow): boolean {
  const audit = objectLike(event.payload) ? event.payload.audit : null;
  if (!objectLike(audit)) return false;
  return (
    audit.workspaceId === event.workspaceId &&
    audit.runId === event.runId &&
    typeof audit.userId === "string" &&
    audit.userId.length > 0 &&
    typeof audit.actionId === "string" &&
    audit.actionId.length > 0
  );
}

function failedToolResult(event: AgentTraceEventRow): boolean {
  if (event.type !== "tool_result" || !objectLike(event.payload)) return false;
  return event.payload.ok === false || typeof event.payload.error === "string";
}

function plural(count: number, singular: string, pluralized = singular + "s"): string {
  return String(count) + " " + (count === 1 ? singular : pluralized);
}

export function agentObservabilityFromTraces(input: {
  runs: readonly AgentTraceRunRow[];
  events: readonly AgentTraceEventRow[];
  liveSessions?: readonly WorkspaceLiveSession[];
  schedulerJobs?: readonly SchedulerJobState[];
  staleCutoffMs?: number;
  nowMs: number;
}): AgentObservabilityView {
  const toolCalls = input.events.filter((event) => event.type === "tool_call");
  const auditedToolCalls = toolCalls.filter(hasAuditEnvelope).length;
  const unauditedToolCalls = toolCalls.length - auditedToolCalls;
  const staleCutoffMs = input.staleCutoffMs ?? STALLED_RUN_AGE_MS;
  const liveSessions = input.liveSessions ?? [];
  const runningRuns =
    liveSessions.length > 0
      ? liveSessions.filter((session) => session.status === "running").length
      : input.runs.filter((run) => run.status === "open").length;
  const queueDepth = liveSessions.filter((session) => session.status === "provisioning").length;
  const stalledRuns =
    liveSessions.length > 0
      ? liveSessions.filter((session) => input.nowMs - session.progressAt.getTime() >= staleCutoffMs).length
      : input.runs.filter(
          (run) => run.status === "open" && input.nowMs - run.startedAt.getTime() >= staleCutoffMs,
        ).length;
  const failedRuns = new Set(
    input.events
      .filter((event) => failedToolResult(event) && input.nowMs - event.occurredAt.getTime() <= DAY_MS)
      .map((event) => event.runId),
  );
  const scheduler = schedulerStatus(input.schedulerJobs ?? [], input.nowMs);
  const alerts: string[] = [];
  if (scheduler.status === "unknown") alerts.push("Scheduler heartbeat is not available");
  if (scheduler.status === "stopped") alerts.push("Scheduler cursor is overdue");
  if (scheduler.status === "degraded") alerts.push("Scheduler has recent failures");
  if (unauditedToolCalls > 0) {
    alerts.push(plural(unauditedToolCalls, "tool call") + " audit envelopes are missing or incomplete");
  }
  if (stalledRuns > 0) alerts.push(plural(stalledRuns, "agent run") + " stalled");
  if (failedRuns.size > 0) alerts.push(plural(failedRuns.size, "agent run") + " failed in the last 24h");

  return {
    scheduler,
    queueDepth,
    runningRuns,
    stalledRuns,
    failedRunsLast24h: failedRuns.size,
    retryRate: null,
    recovery: {
      state: stalledRuns > 0 ? "needs_human" : "unknown",
      retryableStuckRuns: 0,
      lastRecoveryAtMs: null,
    },
    audit: {
      toolCalls: toolCalls.length,
      auditedToolCalls,
      unauditedToolCalls,
      coverage: toolCalls.length === 0 ? null : auditedToolCalls / toolCalls.length,
    },
    connectorSilentFailures: [],
    alerts,
  };
}

function schedulerStatus(
  jobs: readonly SchedulerJobState[],
  nowMs: number,
): AgentObservabilityView["scheduler"] {
  if (jobs.length === 0) return { status: "unknown", lastTickAgeSeconds: null };
  const lastRunAtMs = Math.max(...jobs.map((job) => job.lastRunAtMs ?? 0));
  const lastTickAgeSeconds =
    lastRunAtMs > 0 ? Math.max(0, Math.floor((nowMs - lastRunAtMs) / 1000)) : null;
  if (jobs.some((job) => job.lastStatus === "error" || job.consecutiveFailures > 0)) {
    return { status: "degraded", lastTickAgeSeconds };
  }
  const overdue = jobs.some((job) => {
    if (job.lockedUntilMs !== null && job.lockedUntilMs > nowMs) return false;
    return nowMs > job.nextRunAtMs + Math.max(job.intervalMs, 60_000);
  });
  if (overdue) return { status: "stopped", lastTickAgeSeconds };
  if (lastTickAgeSeconds === null) return { status: "unknown", lastTickAgeSeconds };
  return { status: "healthy", lastTickAgeSeconds };
}
