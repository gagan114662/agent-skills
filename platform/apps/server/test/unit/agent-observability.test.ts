import { describe, expect, it } from "vitest";
import { agentObservabilityFromTraces } from "../../src/founder-console/agent-observability.js";
import type { AgentTraceEventRow, AgentTraceRunRow } from "../../src/db/repositories/agent-trace.js";

const NOW = Date.parse("2026-06-27T08:00:00Z");
const WS = "ws-1";

function run(over: Partial<AgentTraceRunRow> = {}): AgentTraceRunRow {
  return {
    id: "run-1",
    workspaceId: WS,
    sessionId: null,
    agentMemberId: "agent-1",
    taskId: null,
    label: "Scout",
    status: "closed",
    eventCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    startedAt: new Date(NOW - 60_000),
    endedAt: new Date(NOW - 10_000),
    ...over,
  };
}

function event(over: Partial<AgentTraceEventRow> = {}): AgentTraceEventRow {
  return {
    id: "event-1",
    runId: "run-1",
    workspaceId: WS,
    seq: 0,
    type: "tool_call",
    turn: 0,
    label: "search",
    payload: {},
    inputTokens: null,
    outputTokens: null,
    costMicros: null,
    occurredAt: new Date(NOW - 5_000),
    ...over,
  };
}

describe("agentObservabilityFromTraces (#1292)", () => {
  it("counts successful and failed audited tool calls as fully covered", () => {
    const view = agentObservabilityFromTraces({
      nowMs: NOW,
      runs: [run({ id: "run-ok" }), run({ id: "run-fail" })],
      events: [
        event({
          id: "ok-call",
          runId: "run-ok",
          payload: { audit: { workspaceId: WS, userId: "user-1", runId: "run-ok", actionId: "act-ok" } },
        }),
        event({
          id: "ok-result",
          runId: "run-ok",
          seq: 1,
          type: "tool_result",
          payload: { ok: true },
        }),
        event({
          id: "fail-call",
          runId: "run-fail",
          payload: { audit: { workspaceId: WS, userId: "user-1", runId: "run-fail", actionId: "act-fail" } },
        }),
        event({
          id: "fail-result",
          runId: "run-fail",
          seq: 1,
          type: "tool_result",
          payload: { ok: false, error: "provider timeout" },
        }),
      ],
    });

    expect(view.audit).toMatchObject({
      toolCalls: 2,
      auditedToolCalls: 2,
      unauditedToolCalls: 0,
      coverage: 1,
    });
    expect(view.failedRunsLast24h).toBe(1);
    expect(view.alerts).toContain("1 agent run failed in the last 24h");
  });

  it("flags tool calls missing user/run/action audit ids as unaudited", () => {
    const view = agentObservabilityFromTraces({
      nowMs: NOW,
      runs: [run()],
      events: [
        event({ id: "good", payload: { audit: { workspaceId: WS, userId: "u", runId: "run-1", actionId: "a" } } }),
        event({ id: "missing-user", seq: 1, payload: { audit: { workspaceId: WS, runId: "run-1", actionId: "b" } } }),
        event({ id: "wrong-run", seq: 2, payload: { audit: { workspaceId: WS, userId: "u", runId: "other", actionId: "c" } } }),
      ],
    });

    expect(view.audit.toolCalls).toBe(3);
    expect(view.audit.auditedToolCalls).toBe(1);
    expect(view.audit.unauditedToolCalls).toBe(2);
    expect(view.audit.coverage).toBe(1 / 3);
    expect(view.alerts).toContain("2 tool calls audit envelopes are missing or incomplete");
  });

  it("marks old open trace runs as stalled and requiring recovery", () => {
    const view = agentObservabilityFromTraces({
      nowMs: NOW,
      runs: [run({ status: "open", startedAt: new Date(NOW - 30 * 60_000), endedAt: null })],
      events: [],
    });

    expect(view.runningRuns).toBe(1);
    expect(view.stalledRuns).toBe(1);
    expect(view.recovery.state).toBe("needs_human");
    expect(view.alerts).toContain("1 agent run stalled");
  });
});
