/**
 * Durable run logs (issue #665) + failing-tool-call surfacing (issue #666) — public types.
 *
 * A *run log* is the append-only, durably-persisted stream of an agent run's output lines (the runtime
 * line-buffers stdout/stderr and, today, drops the buffer on restart — so a post-mortem of a run that
 * outlived the server process is impossible). This module gives those lines a home that survives a restart,
 * with a retention window, plus a typed *failure* record that pins the exact tool call (name + redacted
 * args + error) that sank a run — so a failed run can name what broke instead of an opaque "failed".
 *
 * Everything here is already user-safe: the service redacts every line and every arg at the write door
 * (secret values + sensitive keys, the same #25/#200 boundary the #560 trace enforces) before it persists.
 */

/** Which side of the agent's output a line came from. `system` is harness/runtime narration. */
export type LogStream = "stdout" | "stderr" | "system";

/** A persisted run-log line, in user-safe (already-redacted, length-capped) form. */
export interface RunLogLine {
  id: string;
  workspaceId: string;
  runId: string;
  /** Globally-monotonic cursor (DB identity / in-memory counter). Filter with `afterSeq` to tail. */
  seq: number;
  stream: LogStream;
  text: string;
  occurredAt: Date;
}

/** One line to append. `text` is redacted by the service before it is persisted. */
export interface AppendLineInput {
  stream?: LogStream;
  text: string;
  occurredAt?: Date;
}

/** Read filter for a run's log — incremental tail (`afterSeq`) + a bounded page (`limit`). */
export interface LogQuery {
  /** Return only lines with `seq` strictly greater than this cursor (incremental polling). */
  afterSeq?: number;
  /** Cap on returned lines (the store enforces a hard ceiling regardless). */
  limit?: number;
}

/** A run's persisted log page plus the next poll cursor. */
export interface RunLog {
  runId: string;
  lines: RunLogLine[];
  /** Highest `seq` in `lines` (0 when empty) — pass back as `afterSeq` to fetch only what's new. */
  cursor: number;
}

/** The failing tool call attached to a run's failure state (issue #666). */
export interface FailingToolCall {
  /** The tool whose call failed (e.g. `bash`, `web.fetch`, an MCP tool name). */
  toolName: string;
  /** The tool's arguments, redacted (sensitive keys masked, known secret values scrubbed, strings capped). */
  args: Record<string, unknown>;
  /** The error the tool produced (message or class) — what the run shows as the cause. */
  error: string;
}

/** What a caller hands the service to record a run's failing tool call. `args`/`error` are redacted first. */
export interface RecordFailureInput {
  toolName: string;
  args?: Record<string, unknown>;
  error: string;
  occurredAt?: Date;
}

/** A persisted run failure: the failing tool call plus where/when it happened. */
export interface RunFailure extends FailingToolCall {
  workspaceId: string;
  runId: string;
  occurredAt: Date;
}
