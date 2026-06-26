/**
 * Live "theater" projection over an agent run's trace (issue #624).
 *
 * The #560 trace is the append-only record of what a model saw and did. The *theater* turns that record
 * into a live, human-watchable stream of **reasoning → action → artifact**: as each event lands, it is
 * projected to a compact {@link TheaterEvent} (a phase + a one-line summary) and pushed to anyone watching
 * over SSE. This module is the PURE core — phase mapping, payload summarizing, cursor diffing, and SSE
 * frame formatting — with zero IO, so the projection is unit-tested with plain objects and the Fastify
 * route (`routes/traces.ts`) only does the socket plumbing. Payloads arriving here are already
 * secret-redacted at the trace write site (`trace/redact.ts`), so summarizing them re-exposes nothing.
 */
import type { TraceEvent, TraceEventType } from "./types.js";

/** The five watchable phases of a run, derived 1:1 from the underlying trace event type. */
export type TheaterPhase = "context" | "reasoning" | "action" | "artifact" | "approval";

export interface TheaterBrowserAction {
  tool: string;
  url: string | null;
  decision: string | null;
  approvalRequestId: string | null;
  screenshotPath: string | null;
  status: number | null;
  summary: string;
}

/** A trace event projected for the live theater: a phase, a short label, and a one-line summary. */
export interface TheaterEvent {
  id: string;
  runId: string;
  seq: number;
  turn: number;
  type: TraceEventType;
  phase: TheaterPhase;
  label: string | null;
  /** A short, already-redacted human summary of what happened (≤ {@link SUMMARY_MAX} chars). */
  summary: string;
  /** Browser/computer-use receipt metadata (#520), extracted from already-redacted trace payloads. */
  browser: TheaterBrowserAction | null;
  /** ISO-8601 timestamp the event occurred. */
  occurredAt: string;
}

/** Max length of a projected summary — long enough to read, short enough to stream cheaply. */
export const SUMMARY_MAX = 280;

/** Map a raw trace event type to the watchable phase the theater renders it as. */
export function phaseForType(type: TraceEventType): TheaterPhase {
  switch (type) {
    case "model_request":
      return "context";
    case "model_response":
      return "reasoning";
    case "tool_call":
      return "action";
    case "tool_result":
      return "artifact";
    case "approval_decision":
      return "approval";
  }
}

function clamp(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

const BROWSER_TOOL_NAMES = new Set(["navigate", "read_page", "screenshot", "scroll", "wait", "click", "type"]);

function firstPayloadObject(payload: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["result", "output", "data", "receipt"]) {
    const value = payload[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return payload;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function browserActionForEvent(
  type: TraceEventType,
  label: string | null,
  payload: Record<string, unknown>,
): TheaterBrowserAction | null {
  const candidate = firstPayloadObject(payload);
  const tool = stringOrNull(candidate.tool) ?? (label && BROWSER_TOOL_NAMES.has(label) ? label : null);
  if (!tool || !BROWSER_TOOL_NAMES.has(tool)) return null;
  const url = stringOrNull(candidate.url) ?? stringOrNull(payload.url);
  const decision = stringOrNull(candidate.decision);
  const approvalRequestId = stringOrNull(candidate.approvalRequestId);
  const screenshotPath = stringOrNull(candidate.screenshotPath);
  const status = numberOrNull(candidate.status);
  const detail = summarizeTracePayload(type, label, payload);
  const summary =
    decision === "needs_approval"
      ? `${tool} is waiting for approval`
      : url
        ? `${tool} on ${url}`
        : detail;
  return { tool, url, decision, approvalRequestId, screenshotPath, status, summary: clamp(summary) };
}

/** First non-empty string found at any of the candidate keys of a payload object. */
function pickString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value)) {
      const joined = value
        .map((v) => (typeof v === "string" ? v : typeof v === "object" && v ? pickString(v as Record<string, unknown>, ["text", "content"]) : null))
        .filter((v): v is string => Boolean(v))
        .join(" ");
      if (joined.trim()) return joined;
    }
  }
  return null;
}

/**
 * Best-effort one-line summary of a trace event's (already-redacted) payload, by phase. Faithful, not
 * clever: it reads the conventional fields the harness writes (reasoning/text/content, args/input,
 * result/output/summary, verdict) and otherwise falls back to compact JSON — so a run never streams a
 * blank line, and never throws on an unexpected shape.
 */
export function summarizeTracePayload(
  type: TraceEventType,
  label: string | null,
  payload: Record<string, unknown>,
): string {
  let picked: string | null = null;
  switch (type) {
    case "model_response":
      picked = pickString(payload, ["reasoning", "text", "content", "message", "thought"]);
      break;
    case "model_request":
      picked = pickString(payload, ["task", "prompt", "system", "instruction", "text"]);
      break;
    case "tool_call":
      picked = pickString(payload, ["summary", "args", "input", "arguments", "command", "query"]);
      break;
    case "tool_result":
      picked = pickString(payload, ["summary", "result", "output", "text", "content", "preview"]);
      break;
    case "approval_decision":
      picked = pickString(payload, ["reason", "rationale", "summary", "verdict", "detail"]);
      break;
  }
  if (picked) return clamp(picked);
  // No conventional field — render the payload compactly so the watcher still sees *something* real.
  const keys = Object.keys(payload);
  if (keys.length === 0) return label ? clamp(label) : type;
  try {
    return clamp(JSON.stringify(payload));
  } catch {
    return label ? clamp(label) : type;
  }
}

/** Project a persisted trace event into its live-theater form. */
export function toTheaterEvent(event: TraceEvent): TheaterEvent {
  return {
    id: event.id,
    runId: event.runId,
    seq: event.seq,
    turn: event.turn,
    type: event.type,
    phase: phaseForType(event.type),
    label: event.label,
    summary: summarizeTracePayload(event.type, event.label, event.payload),
    browser: browserActionForEvent(event.type, event.label, event.payload),
    occurredAt:
      event.occurredAt instanceof Date ? event.occurredAt.toISOString() : String(event.occurredAt),
  };
}

/**
 * Select the events newer than a seq cursor, in seq order, and report the new cursor. The theater streams
 * incrementally: on each poll it asks "what landed since I last looked?" — this is that, pure, so the
 * polling loop in the route holds no diffing logic of its own.
 */
export function selectNewEvents(
  events: readonly TraceEvent[],
  cursor: number,
): { events: TraceEvent[]; cursor: number } {
  const fresh = events.filter((e) => e.seq > cursor).sort((a, b) => a.seq - b.seq);
  const nextCursor = fresh.length > 0 ? fresh[fresh.length - 1]!.seq : cursor;
  return { events: fresh, cursor: nextCursor };
}

/**
 * Format one Server-Sent Events frame. `event` names the channel the browser `EventSource` listens on
 * (`addEventListener(event, …)`); `data` is JSON-encoded on a single line (SSE is newline-framed, so the
 * payload must not contain a raw newline — `JSON.stringify` guarantees that).
 */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An SSE comment line — used as a heartbeat to keep proxies/load-balancers from idling the socket out. */
export function sseComment(text = "ping"): string {
  return `: ${text}\n\n`;
}
