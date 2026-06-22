/**
 * Unified observation/replay trace (issue #560) — public types.
 *
 * A *trace* is the append-only record of one agent run: every model request (system+messages+tools),
 * every response (incl reasoning), every tool call+result, and every #13 approval-gate decision, in the
 * order they happened, with timestamps and token/cost. It exists to answer "what did the model actually
 * see, and what did it do?" — and to be REPLAYED into the reconstructed decision path. Every payload is
 * secret-redacted at the write site before it is persisted (see `trace/redact.ts`).
 */

export type TraceEventType =
  | "model_request"
  | "model_response"
  | "tool_call"
  | "tool_result"
  | "approval_decision";

export type TraceRunStatus = "open" | "closed";

/** Token/cost accounting attached to an event (and rolled up onto the run). All optional. */
export interface TraceUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Cost in micro-dollars (1e-6 USD), integer — avoids float drift in the rollup. */
  costMicros?: number | null;
}

/** Open a trace for a run. `sessionId` links the #25 agent_sessions run when one exists. */
export interface OpenTraceRequest {
  workspaceId: string;
  sessionId?: string | null;
  agentMemberId?: string | null;
  taskId?: string | null;
  label?: string | null;
}

/** Append one event to a run's trace. `payload` is redacted by the service before it is persisted. */
export interface AppendEventRequest {
  type: TraceEventType;
  /** Logical turn index — a request + its response + the tools it called share a turn. */
  turn?: number;
  /** Short label (model name, tool name, decision verdict). */
  label?: string | null;
  /** The structured content. Redacted at the write site; never store a raw secret-bearing object. */
  payload: Record<string, unknown>;
  usage?: TraceUsage;
  /** When the event happened; defaults to now. */
  occurredAt?: Date;
}

/** A persisted trace event, in user-safe (already-redacted) form. */
export interface TraceEvent {
  id: string;
  runId: string;
  seq: number;
  type: TraceEventType;
  turn: number;
  label: string | null;
  payload: Record<string, unknown>;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  occurredAt: Date;
}

/** The trace header + rollup. */
export interface TraceRun {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  agentMemberId: string | null;
  taskId: string | null;
  label: string | null;
  status: TraceRunStatus;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  startedAt: Date;
  endedAt: Date | null;
}

/** A full trace: the run header plus its events in replay (seq) order. */
export interface TraceWithEvents {
  run: TraceRun;
  events: TraceEvent[];
}

/** One reconstructed turn of a replay: the request the model saw, its response, the tools it ran. */
export interface ReplayTurn {
  turn: number;
  request: TraceEvent | null;
  response: TraceEvent | null;
  toolCalls: { call: TraceEvent; result: TraceEvent | null }[];
  approvals: TraceEvent[];
}

/** A replay: the run plus its decision path reconstructed turn-by-turn from the append-only log. */
export interface TraceReplay {
  run: TraceRun;
  turns: ReplayTurn[];
  /** Events that did not fit any turn structure (kept so a replay never silently drops an event). */
  orphans: TraceEvent[];
}
