import type { AgentTraceEventRow, AgentTraceRunRow } from "../db/repositories/agent-trace.js";
import { redactTracePayload } from "./redact.js";
import type {
  AppendEventRequest,
  OpenTraceRequest,
  ReplayTurn,
  TraceEvent,
  TraceEventType,
  TraceReplay,
  TraceRun,
  TraceWithEvents,
} from "./types.js";

/**
 * The observation/replay trace service (issue #560): the one place that turns "the model saw X / the
 * agent did Y" into a redacted, ordered, replayable record. Pure with injected IO seams (`TraceDeps`) —
 * unit-tested with fakes; `trace/default.ts` binds the seams to the real repo. The runtime/harness calls
 * this, never the repo directly, so secret redaction (#25/#200) can never be bypassed: every event
 * payload is run through {@link redactTracePayload} (known secret values + sensitive keys) before persist.
 */

/** Persistence seam. `default.ts` binds these to `db/repositories/agent-trace.ts`. */
export interface TraceDeps {
  /** Known secret VALUES for a run (env injected at provision time), used to redact payloads. */
  secretsForRun(workspaceId: string, runId: string): Promise<string[]>;
  openRun(input: {
    workspaceId: string;
    sessionId?: string | null;
    agentMemberId?: string | null;
    taskId?: string | null;
    label?: string | null;
  }): Promise<{ id: string }>;
  appendEvent(input: {
    runId: string;
    workspaceId: string;
    type: TraceEventType;
    turn: number;
    label: string | null;
    payload: Record<string, unknown>;
    inputTokens: number | null;
    outputTokens: number | null;
    costMicros: number | null;
    occurredAt: Date;
  }): Promise<{ id: string; seq: number }>;
  closeRun(workspaceId: string, runId: string): Promise<void>;
  getRun(workspaceId: string, runId: string): Promise<AgentTraceRunRow | undefined>;
  listEvents(workspaceId: string, runId: string): Promise<AgentTraceEventRow[]>;
  listRuns(
    workspaceId: string,
    filter: { sessionId?: string; limit?: number },
  ): Promise<AgentTraceRunRow[]>;
}

function toRun(row: AgentTraceRunRow): TraceRun {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    agentMemberId: row.agentMemberId,
    taskId: row.taskId,
    label: row.label,
    status: row.status,
    eventCount: row.eventCount,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costMicros: row.costMicros,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

function toEvent(row: AgentTraceEventRow): TraceEvent {
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    type: row.type,
    turn: row.turn,
    label: row.label,
    payload: row.payload,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costMicros: row.costMicros,
    occurredAt: row.occurredAt,
  };
}

/**
 * Reconstruct the decision path from a run's append-only event log (pure — no IO). Events are grouped by
 * `turn` in seq order; within a turn the first request/response are paired and each `tool_call` is paired
 * with the next `tool_result` of the same label. Anything that can't be placed (an unmatched result, a
 * stray event) is kept in `orphans` so a replay NEVER silently drops an event the model actually saw/did.
 */
export function reconstructReplay(run: AgentTraceRunRow, rows: AgentTraceEventRow[]): TraceReplay {
  const events = [...rows].sort((a, b) => a.seq - b.seq).map(toEvent);
  const byTurn = new Map<number, TraceEvent[]>();
  for (const e of events) {
    const list = byTurn.get(e.turn) ?? [];
    list.push(e);
    byTurn.set(e.turn, list);
  }
  const orphans: TraceEvent[] = [];
  const turns: ReplayTurn[] = [];
  for (const turn of [...byTurn.keys()].sort((a, b) => a - b)) {
    const list = byTurn.get(turn)!;
    const t: ReplayTurn = { turn, request: null, response: null, toolCalls: [], approvals: [] };
    const pendingResults = list.filter((e) => e.type === "tool_result");
    const usedResults = new Set<string>();
    for (const e of list) {
      if (e.type === "model_request") {
        if (t.request === null) t.request = e;
        else orphans.push(e);
      } else if (e.type === "model_response") {
        if (t.response === null) t.response = e;
        else orphans.push(e);
      } else if (e.type === "tool_call") {
        const result =
          pendingResults.find(
            (r) => r.seq > e.seq && r.label === e.label && !usedResults.has(r.id),
          ) ?? null;
        if (result) usedResults.add(result.id);
        t.toolCalls.push({ call: e, result });
      } else if (e.type === "approval_decision") {
        t.approvals.push(e);
      }
    }
    for (const r of pendingResults) if (!usedResults.has(r.id)) orphans.push(r);
    turns.push(t);
  }
  orphans.sort((a, b) => a.seq - b.seq);
  return { run: toRun(run), turns, orphans };
}

export class TraceService {
  constructor(private readonly deps: TraceDeps) {}

  /** Open a trace for a run. Returns its id; events are appended against it. */
  async openRun(req: OpenTraceRequest): Promise<{ id: string }> {
    return this.deps.openRun({
      workspaceId: req.workspaceId,
      sessionId: req.sessionId ?? null,
      agentMemberId: req.agentMemberId ?? null,
      taskId: req.taskId ?? null,
      label: req.label ?? null,
    });
  }

  /** Append one event, redacting its payload first. The low-level primitive behind the record* helpers. */
  async append(
    workspaceId: string,
    runId: string,
    req: AppendEventRequest,
  ): Promise<{ id: string; seq: number }> {
    const secrets = await this.deps.secretsForRun(workspaceId, runId);
    const payload = redactTracePayload(req.payload, secrets);
    return this.deps.appendEvent({
      runId,
      workspaceId,
      type: req.type,
      turn: req.turn ?? 0,
      label: req.label ?? null,
      payload,
      inputTokens: req.usage?.inputTokens ?? null,
      outputTokens: req.usage?.outputTokens ?? null,
      costMicros: req.usage?.costMicros ?? null,
      occurredAt: req.occurredAt ?? new Date(),
    });
  }

  /** Record the exact context the model saw: system + messages + tools it was offered. */
  recordModelRequest(workspaceId: string, runId: string, req: Omit<AppendEventRequest, "type">) {
    return this.append(workspaceId, runId, { ...req, type: "model_request" });
  }

  /** Record the model's response, including reasoning, in the same turn as its request. */
  recordModelResponse(workspaceId: string, runId: string, req: Omit<AppendEventRequest, "type">) {
    return this.append(workspaceId, runId, { ...req, type: "model_response" });
  }

  /** Record a tool the model called (name in `label`, args in `payload`). */
  recordToolCall(workspaceId: string, runId: string, req: Omit<AppendEventRequest, "type">) {
    return this.append(workspaceId, runId, { ...req, type: "tool_call" });
  }

  /** Record a tool's result (same `label` as the call so replay can pair them). */
  recordToolResult(workspaceId: string, runId: string, req: Omit<AppendEventRequest, "type">) {
    return this.append(workspaceId, runId, { ...req, type: "tool_result" });
  }

  /** Record a #13 approval-gate decision the run hit (verdict in `label`, gate context in `payload`). */
  recordApprovalDecision(
    workspaceId: string,
    runId: string,
    req: Omit<AppendEventRequest, "type">,
  ) {
    return this.append(workspaceId, runId, { ...req, type: "approval_decision" });
  }

  /** Mark a run closed. */
  async closeRun(workspaceId: string, runId: string): Promise<void> {
    await this.deps.closeRun(workspaceId, runId);
  }

  /** The full trace (header + events in replay order), or undefined if absent/cross-workspace. */
  async getTrace(workspaceId: string, runId: string): Promise<TraceWithEvents | undefined> {
    const run = await this.deps.getRun(workspaceId, runId);
    if (!run) return undefined;
    const events = await this.deps.listEvents(workspaceId, runId);
    return { run: toRun(run), events: events.map(toEvent) };
  }

  /** The replay: the run's decision path reconstructed turn-by-turn. Undefined if absent/cross-workspace. */
  async replay(workspaceId: string, runId: string): Promise<TraceReplay | undefined> {
    const run = await this.deps.getRun(workspaceId, runId);
    if (!run) return undefined;
    const events = await this.deps.listEvents(workspaceId, runId);
    return reconstructReplay(run, events);
  }

  /** List a workspace's trace runs, newest first. */
  async listRuns(
    workspaceId: string,
    filter: { sessionId?: string; limit?: number } = {},
  ): Promise<TraceRun[]> {
    const rows = await this.deps.listRuns(workspaceId, filter);
    return rows.map(toRun);
  }
}
