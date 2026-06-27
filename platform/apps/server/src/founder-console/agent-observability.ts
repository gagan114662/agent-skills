import type { AgentTraceEventRow, AgentTraceRunRow } from "../db/repositories/agent-trace.js";
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
  nowMs: number;
}): AgentObservabilityView {
  const toolCalls = input.events.filter((event) => event.type === "tool_call");
  const auditedToolCalls = toolCalls.filter(hasAuditEnvelope).length;
  const unauditedToolCalls = toolCalls.length - auditedToolCalls;
  const runningRuns = input.runs.filter((run) => run.status === "open").length;
  const stalledRuns = input.runs.filter(
    (run) => run.status === "open" && input.nowMs - run.startedAt.getTime() >= STALLED_RUN_AGE_MS,
  ).length;
  const failedRuns = new Set(
    input.events
      .filter((event) => failedToolResult(event) && input.nowMs - event.occurredAt.getTime() <= DAY_MS)
      .map((event) => event.runId),
  );
  const alerts: string[] = [];
  if (unauditedToolCalls > 0) {
    alerts.push(plural(unauditedToolCalls, "tool call") + " audit envelopes are missing or incomplete");
  }
  if (stalledRuns > 0) alerts.push(plural(stalledRuns, "agent run") + " stalled");
  if (failedRuns.size > 0) alerts.push(plural(failedRuns.size, "agent run") + " failed in the last 24h");

  return {
    scheduler: { status: "unknown", lastTickAgeSeconds: null },
    queueDepth: 0,
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
