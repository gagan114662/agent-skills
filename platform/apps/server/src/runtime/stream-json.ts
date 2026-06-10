/**
 * Harness-aware stream-json output decoding (#81).
 *
 * The `claude-code` harness is spawned with `--output-format stream-json --verbose` (see
 * {@link file://./harness.ts}), so it emits one JSON event object per stdout line — assistant turns,
 * tool calls, and a final result. The runtime ({@link file://./manager.ts}) line-buffers stdout and
 * posts each line into the channel; without a decoder, channel users see raw JSON blobs instead of
 * readable turns/tool-calls. This module converts those events into readable channel text while
 * keeping the parsed event available for structured consumers (run log / turns).
 *
 * The `demo` harness prints plain text, so its decoder is a verbatim pass-through — its output is
 * never parsed, so a JSON-looking demo line streams exactly as printed (no regression).
 */
import type { HarnessKind } from "./harness.js";

export interface DecodedLine {
  /**
   * Human-readable channel lines for this raw stdout line. Empty when the event carries nothing for
   * the channel (e.g. a `system`/`init` event, or a blank line). Redaction is applied by the caller
   * after decoding.
   */
  display: string[];
  /**
   * The parsed structured event, preserved for run-log / turns consumers. `null` when the line was
   * not a JSON object (a plain-text line, e.g. a CLI warning) or was blank.
   */
  raw: unknown | null;
}

export type LineDecoder = (line: string) => DecodedLine;

/** Verbatim pass-through: the line is the channel text; nothing is parsed. The demo-harness contract. */
const passthrough: LineDecoder = (line) => ({ display: [line], raw: null });

/**
 * Pick the output decoder for a harness. `claude-code` → the stream-json decoder; `codex` → the
 * codex `exec --json` decoder; everything else (demo) → verbatim pass-through, so the default
 * harness output is unchanged.
 */
export function harnessLineDecoder(kind: HarnessKind): LineDecoder {
  switch (kind) {
    case "claude-code":
      return decodeClaudeCodeLine;
    case "codex":
      return decodeCodexLine;
    default:
      return passthrough;
  }
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const TOOL = "🔧";
const ERROR = "⚠️";
const INPUT_MAX = 200;

/** Compact, single-line, readable summary of a tool's input (for the tool-call channel line). */
function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (isRecord(input)) {
    // Most tools have a single dominant argument — surface it directly for readability.
    const primary =
      input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query;
    if (typeof primary === "string") return primary;
    const json = JSON.stringify(input);
    return json.length > INPUT_MAX ? `${json.slice(0, INPUT_MAX - 1)}…` : json;
  }
  return String(input);
}

/**
 * Decode one `claude-code` stream-json stdout line into readable channel text + the raw event.
 *
 * - `assistant` events render each `text` block verbatim and each `tool_use` block as a `🔧 <name>
 *   <input>` line.
 * - `result` events render their final summary text (error results are flagged with `⚠️`).
 * - Other recognized events (`system`, `user`/tool-results) are suppressed from the channel but their
 *   raw event is preserved for structured consumers.
 * - A non-JSON line passes through verbatim (so CLI warnings still reach the channel) with no raw
 *   event; a blank line yields nothing.
 */
export function decodeClaudeCodeLine(line: string): DecodedLine {
  if (!line.trim()) return { display: [], raw: null };

  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    // Not JSON — a plain-text CLI line (e.g. a warning). Surface it as-is; it is not a structured event.
    return { display: [line], raw: null };
  }
  if (!isRecord(event)) return { display: [line], raw: null };

  const display: string[] = [];
  switch (event.type) {
    case "assistant": {
      const message = isRecord(event.message) ? event.message : undefined;
      const content = Array.isArray(message?.content) ? (message.content as ContentBlock[]) : [];
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          display.push(block.text);
        } else if (block?.type === "tool_use" && typeof block.name === "string") {
          display.push(`${TOOL} ${block.name} ${summarizeToolInput(block.input)}`.trimEnd());
        }
      }
      break;
    }
    case "result": {
      const summary = typeof event.result === "string" ? event.result : "";
      if (event.is_error) {
        display.push(`${ERROR} ${summary || "agent run ended with an error"}`.trimEnd());
      } else if (summary.trim()) {
        display.push(summary);
      }
      break;
    }
    default:
      // system / user (tool results) / unknown — keep the raw event for structured consumers, but
      // do not clutter the channel with it.
      break;
  }

  return { display, raw: event };
}

/** Compact, single-line summary of a codex `file_change` item's changed paths. */
function summarizeFileChange(item: Record<string, unknown>): string {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const paths = changes
    .map((c) => (isRecord(c) && typeof c.path === "string" ? c.path : undefined))
    .filter((p): p is string => Boolean(p));
  const summary = paths.join(", ") || (typeof item.path === "string" ? item.path : "");
  const text = `file_change ${summary}`.trimEnd();
  return text.length > INPUT_MAX ? `${text.slice(0, INPUT_MAX - 1)}…` : text;
}

/**
 * Decode one `codex exec --json` stdout line into readable channel text + the raw event.
 *
 * Codex emits a thread/item event stream (one JSON object per line). We render the items a channel
 * reader cares about and suppress lifecycle/reasoning noise (keeping the raw event for structured
 * consumers):
 * - `item.completed` + `agent_message` → the assistant's text, verbatim.
 * - `item.completed` + `command_execution` → a `🔧 <command>` tool-call line.
 * - `item.completed` + `file_change` → a `🔧 file_change <paths>` tool-call line.
 * - a top-level `error` (or `turn.failed`) event → an `⚠️` line.
 * - `thread.started` / `turn.started` / `turn.completed` / `reasoning` / unknown → suppressed from
 *   the channel, raw event preserved.
 * - a non-JSON line passes through verbatim (so CLI warnings still reach the channel) with no raw
 *   event; a blank line yields nothing.
 *
 * Mirrors {@link decodeClaudeCodeLine}: redaction is applied by the caller AFTER decoding, so a
 * secret leaked inside a decoded event/command is still scrubbed before it is posted or logged.
 */
export function decodeCodexLine(line: string): DecodedLine {
  if (!line.trim()) return { display: [], raw: null };

  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { display: [line], raw: null };
  }
  if (!isRecord(event)) return { display: [line], raw: null };

  const display: string[] = [];
  if (event.type === "error" || event.type === "turn.failed") {
    const message = typeof event.message === "string" ? event.message : "";
    display.push(`${ERROR} ${message || "codex run ended with an error"}`.trimEnd());
    return { display, raw: event };
  }

  if (event.type === "item.completed" && isRecord(event.item)) {
    const item = event.item;
    switch (item.type) {
      case "agent_message":
        if (typeof item.text === "string" && item.text.trim()) display.push(item.text);
        break;
      case "command_execution":
        if (item.command != null) display.push(`${TOOL} ${summarizeToolInput(item.command)}`.trimEnd());
        break;
      case "file_change":
        display.push(`${TOOL} ${summarizeFileChange(item)}`.trimEnd());
        break;
      case "error":
        display.push(`${ERROR} ${typeof item.message === "string" ? item.message : ""}`.trimEnd());
        break;
      default:
        // reasoning / mcp internal / unknown item — suppressed from the channel.
        break;
    }
  }

  return { display, raw: event };
}
