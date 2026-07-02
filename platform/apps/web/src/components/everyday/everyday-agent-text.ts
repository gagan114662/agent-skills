/**
 * Turns raw agent/team message bodies into customer-facing text for the everyday room.
 *
 * The room is a customer surface (#1463): it must only ever show human-readable, brand-voice lines. Two
 * classes of internal noise otherwise leak into the transcript and must be caught here:
 *
 *  1. Structured `::team-event::` JSON status blobs (teamRunId, agentMemberId, branch, ...). A real event
 *     carries a human `summary`, but a truncated / summary-less / unparseable one must never render as raw
 *     JSON — we degrade it to a friendly per-kind milestone line, or a soft placeholder.
 *  2. Runtime / log output — Rust tracing lines (`codex_core::shell_snapshot ERROR ...`), shell tool
 *     invocations, panics, script framing. None of it belongs in front of a customer.
 *
 * Everything here is pure text-in / text-out so it is trivially unit-testable and reused by both the demo
 * `EverydayShell` and the live `LiveEverydayShell`.
 */
import type { TeamEvent, TeamEventKind } from "@reload/shared";
import { EVERYDAY } from "../../brand.js";

export const TEAM_EVENT_MARKER = "::team-event::";

const TEAM_EVENT_KINDS: readonly TeamEventKind[] = [
  "queued",
  "started",
  "milestone",
  "blocked",
  "needs_handoff",
  "done",
];

/** A friendly, brand-voice milestone line per kind — used when a real team-event has no usable summary. */
const KIND_FALLBACK_LINE: Record<TeamEventKind, string> = {
  queued: "your team lined this up and will start on it shortly.",
  started: "your team started working on this.",
  milestone: "your team just hit a milestone.",
  blocked: "your team paused on a blocker and is sorting it out.",
  needs_handoff: "your team is handing this to a teammate.",
  done: "your team wrapped this up.",
};

const INTERNAL_TOOL_COMMAND_RE =
  /^(?:(?:\/usr\/bin\/|\/bin\/)?(?:sh|bash|zsh)\s+-lc\b|(?:sed|cat|awk|grep|rg|find|curl|gh|git|pnpm|npm|yarn|node|tsx|python3?|flyctl|vercel)\b)/i;

// Runtime / log noise: Rust module paths (codex_core::shell_snapshot), a leading log level (optionally
// after an ISO timestamp), Rust panics, or a bare shell-snapshot marker. Any of these is plumbing.
const RUNTIME_LOG_RE =
  /\bcodex_[a-z0-9_]*::[a-z][a-z0-9_]*|^\s*(?:\[?\d{4}-\d\d-\d\d[T ][\d:.]+Z?\]?\s+)?(?:ERROR|WARN(?:ING)?|DEBUG|TRACE|FATAL)\b|thread\s+'[^']*'\s+panicked|\bshell_snapshot\b/;

const TRIPLE_BACKTICK = String.fromCharCode(96).repeat(3);

/** First non-empty, non-code-fence line, trimmed — what a customer would actually read first. */
export function firstCustomerVisibleLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith(TRIPLE_BACKTICK))[0] ?? ""
  );
}

function isTeamEventKind(value: unknown): value is TeamEventKind {
  return typeof value === "string" && (TEAM_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * Parse a `::team-event::` body into a structural {@link TeamEvent}, or `null` when it is not a team event
 * or cannot be parsed. Structural check (teamRunId + known kind) keeps arbitrary JSON from masquerading as
 * an event while still accepting a real event that happens to lack a summary.
 */
export function parseTeamEvent(body: string | null | undefined): TeamEvent | null {
  if (!body || !body.startsWith(TEAM_EVENT_MARKER)) return null;
  try {
    const parsed = JSON.parse(body.slice(TEAM_EVENT_MARKER.length).trim()) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.teamRunId !== "string" || !isTeamEventKind(parsed.kind)) return null;
    return parsed as unknown as TeamEvent;
  } catch {
    return null;
  }
}

/** A human, brand-voice line for a team-event: its summary when present, else a per-kind milestone line. */
export function teamEventFriendlyLine(event: TeamEvent): string {
  const summary = typeof event.summary === "string" ? event.summary.trim() : "";
  if (summary) return summary;
  return KIND_FALLBACK_LINE[event.kind] ?? EVERYDAY.thread.internalToolActivity;
}

/** True when a raw body is a tool invocation or runtime/log line that must never reach a customer. */
export function looksLikeInternalActivity(text: string): boolean {
  const firstLine = firstCustomerVisibleLine(text)
    .replace(/^\$\s*/, "")
    .replace(/^🔧\s*/, "")
    .replace(/^tool\s*:\s*/i, "");
  return (
    INTERNAL_TOOL_COMMAND_RE.test(firstLine) ||
    RUNTIME_LOG_RE.test(firstLine) ||
    /^(?:script completed|wall time|output:|script error:)/i.test(firstLine)
  );
}

/**
 * Map any agent/team body to the text a customer may see. Never returns raw JSON or log output:
 *  - a team-event → its friendly line (summary, or a per-kind milestone),
 *  - a `::team-event::` blob we could not turn into a friendly line, or any tool/runtime/log noise → the
 *    brand-voice "we'll post the useful bit here" placeholder,
 *  - anything else → the text unchanged.
 */
export function customerVisibleAgentText(text: string): string {
  const event = parseTeamEvent(text);
  if (event) return teamEventFriendlyLine(event);
  if (text.trimStart().startsWith(TEAM_EVENT_MARKER)) return EVERYDAY.thread.internalToolActivity;
  return looksLikeInternalActivity(text) ? EVERYDAY.thread.internalToolActivity : text;
}
