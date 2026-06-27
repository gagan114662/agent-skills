import { describe, it, expect } from "vitest";
import { TraceService, reconstructReplay, type TraceDeps } from "../../src/trace/service.js";
import type { AgentTraceEventRow, AgentTraceRunRow } from "../../src/db/repositories/agent-trace.js";
import { REDACTION_MASK } from "../../src/runtime/redact.js";
import { SENSITIVE_KEY_MASK } from "../../src/trace/redact.js";

/** An in-memory fake of the trace persistence seam — exercises the service with no DB. */
function makeFakeDeps(secrets: Record<string, string> = {}) {
  const runs = new Map<string, AgentTraceRunRow>();
  const events: AgentTraceEventRow[] = [];
  const nextSeq = new Map<string, number>();
  let n = 0;
  const deps: TraceDeps = {
    secretsForRun: async () => Object.values(secrets),
    openRun: async (input) => {
      const id = `run-${++n}`;
      runs.set(id, {
        id,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId ?? null,
        agentMemberId: input.agentMemberId ?? null,
        taskId: input.taskId ?? null,
        label: input.label ?? null,
        status: "open",
        eventCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        startedAt: new Date(),
        endedAt: null,
      });
      nextSeq.set(id, 0);
      return { id };
    },
    appendEvent: async (input) => {
      const run = runs.get(input.runId);
      if (!run || run.workspaceId !== input.workspaceId) throw new Error("not found");
      const seq = nextSeq.get(input.runId)!;
      nextSeq.set(input.runId, seq + 1);
      const id = `ev-${++n}`;
      events.push({ ...input, id, seq });
      run.eventCount += 1;
      run.inputTokens += input.inputTokens ?? 0;
      run.outputTokens += input.outputTokens ?? 0;
      run.costMicros += input.costMicros ?? 0;
      return { id, seq };
    },
    closeRun: async (wid, runId) => {
      const run = runs.get(runId);
      if (run && run.workspaceId === wid) {
        run.status = "closed";
        run.endedAt = new Date();
      }
    },
    getRun: async (wid, runId) => {
      const run = runs.get(runId);
      return run && run.workspaceId === wid ? run : undefined;
    },
    listEvents: async (wid, runId) =>
      events
        .filter((e) => e.workspaceId === wid && e.runId === runId)
        .sort((a, b) => a.seq - b.seq),
    listRuns: async (wid) => [...runs.values()].filter((r) => r.workspaceId === wid),
  };
  return { deps, runs, events };
}

const WS = "ws-1";

describe("TraceService", () => {
  it("redacts secret values and sensitive keys in every event payload before persisting", async () => {
    const { deps, events } = makeFakeDeps({ OPENAI_KEY: "sk-live-TOPSECRET99" });
    const svc = new TraceService(deps);
    const { id: runId } = await svc.openRun({ workspaceId: WS, label: "test run" });

    await svc.recordModelRequest(WS, runId, {
      turn: 0,
      label: "claude-opus",
      payload: {
        system: "you are an agent. the key is sk-live-TOPSECRET99",
        headers: { authorization: "Bearer sk-live-TOPSECRET99" },
      },
      usage: { inputTokens: 100 },
    });

    const stored = JSON.stringify(events[0].payload);
    expect(stored).not.toContain("sk-live-TOPSECRET99");
    expect(stored).toContain(REDACTION_MASK);
    expect(
      (events[0].payload as { headers: Record<string, string> }).headers.authorization,
    ).toBe(SENSITIVE_KEY_MASK);
    expect(events[0].inputTokens).toBe(100);
  });

  it("assigns gap-free seq and rolls up usage onto the run", async () => {
    const { deps } = makeFakeDeps();
    const svc = new TraceService(deps);
    const { id: runId } = await svc.openRun({ workspaceId: WS });
    await svc.recordModelRequest(WS, runId, { turn: 0, payload: { m: 1 }, usage: { inputTokens: 10 } });
    await svc.recordModelResponse(WS, runId, {
      turn: 0,
      payload: { text: "hi" },
      usage: { outputTokens: 20, costMicros: 500 },
    });
    await svc.recordToolCall(WS, runId, { turn: 0, label: "search", payload: { q: "x" } });
    await svc.recordToolResult(WS, runId, { turn: 0, label: "search", payload: { hits: 3 } });
    await svc.recordApprovalDecision(WS, runId, {
      turn: 0,
      label: "approved",
      payload: { gate: "spend", verdict: "approved" },
    });

    const trace = await svc.getTrace(WS, runId);
    expect(trace!.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(trace!.run.inputTokens).toBe(10);
    expect(trace!.run.outputTokens).toBe(20);
    expect(trace!.run.costMicros).toBe(500);
    expect(trace!.run.eventCount).toBe(5);
  });

  it("can emit successful and failed tool-call audit envelopes for observability coverage (#1292)", async () => {
    const { deps } = makeFakeDeps();
    const svc = new TraceService(deps);
    const { id: okRun } = await svc.openRun({ workspaceId: WS, label: "successful run" });
    const { id: failedRun } = await svc.openRun({ workspaceId: WS, label: "failed run" });

    await svc.recordToolCall(WS, okRun, {
      turn: 0,
      label: "search",
      payload: { audit: { workspaceId: WS, userId: "user-1", runId: okRun, actionId: "act-ok" } },
    });
    await svc.recordToolResult(WS, okRun, { turn: 0, label: "search", payload: { ok: true } });
    await svc.recordToolCall(WS, failedRun, {
      turn: 0,
      label: "browser",
      payload: { audit: { workspaceId: WS, userId: "user-1", runId: failedRun, actionId: "act-fail" } },
    });
    await svc.recordToolResult(WS, failedRun, {
      turn: 0,
      label: "browser",
      payload: { ok: false, error: "provider timeout" },
    });

    const okTrace = await svc.getTrace(WS, okRun);
    const failedTrace = await svc.getTrace(WS, failedRun);
    expect(okTrace!.events.find((event) => event.type === "tool_call")!.payload).toMatchObject({
      audit: { workspaceId: WS, userId: "user-1", runId: okRun, actionId: "act-ok" },
    });
    expect(failedTrace!.events.find((event) => event.type === "tool_call")!.payload).toMatchObject({
      audit: { workspaceId: WS, userId: "user-1", runId: failedRun, actionId: "act-fail" },
    });
    expect(failedTrace!.events.find((event) => event.type === "tool_result")!.payload).toMatchObject({
      ok: false,
      error: "provider timeout",
    });
  });

  it("is workspace-scoped: a foreign workspace cannot read the trace", async () => {
    const { deps } = makeFakeDeps();
    const svc = new TraceService(deps);
    const { id: runId } = await svc.openRun({ workspaceId: WS });
    await svc.recordModelRequest(WS, runId, { turn: 0, payload: { m: 1 } });
    expect(await svc.getTrace("ws-other", runId)).toBeUndefined();
    await expect(
      svc.recordModelRequest("ws-other", runId, { turn: 0, payload: { m: 2 } }),
    ).rejects.toThrow();
  });
});

describe("reconstructReplay", () => {
  const run: AgentTraceRunRow = {
    id: "r1",
    workspaceId: WS,
    sessionId: null,
    agentMemberId: null,
    taskId: null,
    label: null,
    status: "closed",
    eventCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    startedAt: new Date(),
    endedAt: new Date(),
  };
  const ev = (
    seq: number,
    type: AgentTraceEventRow["type"],
    turn: number,
    label: string | null = null,
  ): AgentTraceEventRow => ({
    id: `e${seq}`,
    runId: "r1",
    workspaceId: WS,
    seq,
    type,
    turn,
    label,
    payload: {},
    inputTokens: null,
    outputTokens: null,
    costMicros: null,
    occurredAt: new Date(),
  });

  it("reconstructs the decision path turn-by-turn, pairing tool calls with results", () => {
    const events = [
      ev(0, "model_request", 0),
      ev(1, "model_response", 0),
      ev(2, "tool_call", 0, "search"),
      ev(3, "tool_result", 0, "search"),
      ev(4, "model_request", 1),
      ev(5, "model_response", 1),
      ev(6, "approval_decision", 1, "approved"),
    ];
    const replay = reconstructReplay(run, events);
    expect(replay.turns).toHaveLength(2);
    expect(replay.turns[0].request!.seq).toBe(0);
    expect(replay.turns[0].response!.seq).toBe(1);
    expect(replay.turns[0].toolCalls).toHaveLength(1);
    expect(replay.turns[0].toolCalls[0].result!.seq).toBe(3);
    expect(replay.turns[1].approvals).toHaveLength(1);
    expect(replay.orphans).toHaveLength(0);
  });

  it("never drops an event — a tool_result with no matching call lands in orphans", () => {
    const events = [ev(0, "model_request", 0), ev(1, "tool_result", 0, "ghost")];
    const replay = reconstructReplay(run, events);
    expect(replay.turns[0].request!.seq).toBe(0);
    expect(replay.orphans.map((e) => e.seq)).toEqual([1]);
  });
});
