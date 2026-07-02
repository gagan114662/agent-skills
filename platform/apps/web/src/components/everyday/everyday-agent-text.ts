/**
 * Turns raw agent/team message bodies into customer-facing text for the everyday room.
 *
 * The room is a customer surface (#1463/#1584): it must read like a real team chat, never a pipeline
 * telemetry feed. Three classes of internal noise otherwise leak into the transcript and are caught here:
 *
 *  1. Structured `::team-event::` JSON status blobs (teamRunId, agentMemberId, branch, ...). A real event
 *     carries a human `summary`, but the coordinator's own lifecycle summaries are telemetry
 *     ("queued: Lens taste and proof", "started: Scout insight mining", "blocked: missing required
 *     artifact"). Those are rewritten into first-person, named-agent, outcome-focused updates with visible
 *     handoffs. A truncated / unparseable blob degrades to a soft placeholder.
 *  2. Session terminal lines — `✅ session completed (exit 0)` / `❌ … _(spawn)_ … session failed · exit n/a`.
 *     The exit-code success line is plumbing; the failure line is rewritten to honest plain language with
 *     the class tag / exit footer stripped.
 *  3. Runtime / log output — Rust tracing lines (`codex_core::shell_snapshot ERROR ...`), shell tool
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

/**
 * The named room team. Each agent has a customer-facing role label and the teammate it hands off to, so a
 * finished lane can conversationally tag whoever picks up next (rule 3). `Operator` is the display name for
 * the Codex operator lane. Kept here (not in brand.ts) because it is reused by the pure text transforms.
 */
export interface RoomAgentProfile {
  readonly name: string;
  readonly role: string;
  readonly next: string | null;
}

export const ROOM_AGENT_PROFILES: readonly RoomAgentProfile[] = [
  { name: "Scout", role: "Research", next: "Quill" },
  { name: "Quill", role: "Copy", next: "Lens" },
  { name: "Lens", role: "Taste", next: "Echo" },
  { name: "Echo", role: "Distribution", next: null },
  { name: "Operator", role: "Operator", next: null },
];

/** First-person start/finish lines per agent. The finish line names the next teammate for a visible handoff. */
const AGENT_LINES: Record<string, { readonly started: string; readonly done: string }> = {
  Scout: {
    started: "I'm digging into your site and market to find the sharpest angle to lead with.",
    done: "Research is done — I've found the angle worth leading with. Handing the brief to Quill.",
  },
  Quill: {
    started: "I'm turning Scout's research into a first draft of the campaign.",
    done: "First draft's ready. Passing it to Lens to pressure-test before it reaches you.",
  },
  Lens: {
    started: "I'm reviewing the drafts for clarity, proof, and voice.",
    done: "I've scored the drafts and left notes. Handing the strongest one to Echo to plan distribution.",
  },
  Echo: {
    started: "I'm planning where and how to get this in front of the right people.",
    done: "Distribution plan's ready — nothing goes out until you approve it.",
  },
  Operator: {
    started: "I'm turning the approved decisions into real product changes.",
    done: "I've finished the build work and left the links for you to check.",
  },
};

/** A soft, brand-voice line per kind — used when a real team-event has no usable summary at all. */
const KIND_FALLBACK_LINE: Record<TeamEventKind, string> = {
  queued: "Getting set up — I'll post here the moment I've got something worth sharing.",
  started: "On it now.",
  milestone: "Made some progress — more in a moment.",
  blocked: "I've hit a snag I can't get past on my own yet. Sorting it out.",
  needs_handoff: "Passing this along to the next teammate.",
  done: "Wrapped this up.",
};

const INTERNAL_TOOL_COMMAND_RE =
  /^(?:(?:\/usr\/bin\/|\/bin\/)?(?:sh|bash|zsh)\s+-lc\b|(?:sed|cat|awk|grep|rg|find|curl|gh|git|pnpm|npm|yarn|node|tsx|python3?|flyctl|vercel)\b)/i;

// Runtime / log noise: Rust module paths (codex_core::shell_snapshot), a leading log level (optionally
// after an ISO timestamp), Rust panics, or a bare shell-snapshot marker. Any of these is plumbing.
const RUNTIME_LOG_RE =
  /\bcodex_[a-z0-9_]*::[a-z][a-z0-9_]*|^\s*(?:\[?\d{4}-\d\d-\d\d[T ][\d:.]+Z?\]?\s+)?(?:ERROR|WARN(?:ING)?|DEBUG|TRACE|FATAL)\b|thread\s+'[^']*'\s+panicked|\bshell_snapshot\b/;

const TRIPLE_BACKTICK = String.fromCharCode(96).repeat(3);

/** The coordinator's lifecycle verbs — the summary shapes that are telemetry, not team chat. */
type LifecycleVerb = "queued" | "started" | "done" | "retrying" | "blocked";
const LIFECYCLE_RE = /^(queued|started|done|retrying|blocked):\s*(.*)$/is;
const MISSING_ARTIFACT_RE = /missing (?:required|produced) artifact/i;

const SESSION_SUCCESS_RE = /^\s*✅\s*session\s+(?:completed|done)\b/i;
const SESSION_FAILURE_RE = /^\s*❌\s*/;

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

/**
 * Normalise any raw display name to a canonical room-agent name. The Codex operator lane surfaces under the
 * customer-facing name "Operator"; known agents resolve case-insensitively; anything else (a human's name,
 * an unknown handle) is returned trimmed and unchanged.
 */
export function canonicalRoomAgentName(raw: string): string {
  const name = raw.trim();
  const lower = name.toLowerCase();
  if (lower.includes("codex") || lower.includes("operator")) return "Operator";
  const hit = ROOM_AGENT_PROFILES.find((profile) => profile.name.toLowerCase() === lower);
  return hit ? hit.name : name;
}

/** The profile for a room agent by (possibly raw) name, or `null` when the name is not a known teammate. */
export function roomAgentProfile(name: string): RoomAgentProfile | null {
  const canonical = canonicalRoomAgentName(name);
  return ROOM_AGENT_PROFILES.find((profile) => profile.name === canonical) ?? null;
}

/** The customer-facing role label for a room agent (e.g. "Research"), or `null` for a non-teammate. */
export function roomAgentRole(name: string): string | null {
  return roomAgentProfile(name)?.role ?? null;
}

/** The named agent a coordinator lane summary refers to (e.g. "Scout insight mining" → "Scout"), or null. */
function agentFromLane(rest: string): string | null {
  const firstWord = rest.trim().split(/\s+/)[0] ?? "";
  if (!firstWord) return null;
  const canonical = canonicalRoomAgentName(firstWord);
  return roomAgentProfile(canonical) ? canonical : null;
}

interface Lifecycle {
  readonly verb: LifecycleVerb;
  readonly agent: string | null;
  readonly rest: string;
}

/**
 * Recognise a coordinator lifecycle summary and pull out the verb, the named agent (when the lane summary
 * carries one), and the remaining text. Returns `null` for a genuine agent-authored summary — those pass
 * through untouched, so a real one-liner like "reading your homepage" is never rewritten.
 */
function parseLifecycleSummary(summary: string): Lifecycle | null {
  const match = LIFECYCLE_RE.exec(summary.trim());
  if (!match) return null;
  const verb = match[1]!.toLowerCase() as LifecycleVerb;
  let rest = match[2]!.trim();
  // "retrying: <lane> after <error>" — we never surface the raw error tail.
  if (verb === "retrying") {
    const afterIdx = rest.toLowerCase().indexOf(" after ");
    if (afterIdx >= 0) rest = rest.slice(0, afterIdx).trim();
  }
  return { verb, agent: agentFromLane(rest), rest };
}

/** The named agent a team-event refers to (from its lifecycle summary), or `null` when unknown. */
export function teamEventAgentName(event: TeamEvent): string | null {
  const summary = typeof event.summary === "string" ? event.summary : "";
  return parseLifecycleSummary(summary)?.agent ?? null;
}

/** Turn a parsed lifecycle event into a first-person, named-agent, outcome-focused, jargon-free line. */
function lifecycleLine(lifecycle: Lifecycle): string {
  const profile = lifecycle.agent ? roomAgentProfile(lifecycle.agent) : null;
  switch (lifecycle.verb) {
    case "queued":
      return KIND_FALLBACK_LINE.queued;
    case "retrying":
      return "Hit a snag on that last step — taking another run at it now.";
    case "blocked":
      return MISSING_ARTIFACT_RE.test(lifecycle.rest)
        ? "I'm waiting on the earlier step to finish before I can pick this up."
        : KIND_FALLBACK_LINE.blocked;
    case "started":
      return profile ? AGENT_LINES[profile.name]!.started : KIND_FALLBACK_LINE.started;
    case "done":
      return profile ? AGENT_LINES[profile.name]!.done : KIND_FALLBACK_LINE.done;
  }
}

/**
 * A human, brand-voice line for a team-event:
 *  - a coordinator lifecycle summary → a rewritten first-person, named, handoff-aware update,
 *  - a genuine agent-authored summary → the summary itself (jargon-scrubbed),
 *  - no usable summary → a per-kind soft fallback.
 */
export function teamEventFriendlyLine(event: TeamEvent): string {
  const summary = typeof event.summary === "string" ? event.summary.trim() : "";
  if (summary) {
    const lifecycle = parseLifecycleSummary(summary);
    if (lifecycle) return lifecycleLine(lifecycle);
    return scrubInternalJargon(summary) || KIND_FALLBACK_LINE[event.kind] || EVERYDAY.thread.internalToolActivity;
  }
  return KIND_FALLBACK_LINE[event.kind] ?? EVERYDAY.thread.internalToolActivity;
}

/**
 * Strip pipeline jargon a customer must never see (rule 4): exit codes, `session … · exit …` footers,
 * failure class tags like `_(spawn)_`, UUIDs, and worktree branch tokens. Whitespace is re-collapsed.
 * Deliberately narrow so genuine copy that merely contains a normal word is left intact.
 */
export function scrubInternalJargon(text: string): string {
  return text
    .replace(/`[^`]*\bsession\b[^`]*·\s*exit[^`]*`/gi, "") // `session failed · exit n/a`
    .replace(/\bsession\s+\w+\s*·\s*exit\s+(?:\d+|n\/a)/gi, "")
    .replace(/\(?\bexit\s+(?:code\s+)?(?:\d+|n\/a)\)?/gi, "") // "(exit 0)", "exit n/a"
    .replace(/_\([a-z]+\)_/gi, "") // "_(spawn)_"
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "") // UUID
    .replace(/\bipop-[a-z0-9-]+\b/gi, "") // worktree branch token
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
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

/** True when a body is the runtime's success terminal line (`✅ session completed (exit 0)`) — pure plumbing. */
export function isSessionOutcomeSuccessLine(text: string): boolean {
  return SESSION_SUCCESS_RE.test(firstCustomerVisibleLine(text));
}

/**
 * Rewrite the runtime's failure terminal line into honest plain language (rule 5): keep the brand-voice
 * headline + what-to-do-next, drop the `❌`, the `_(class)_` tag, and the `session … · exit …` footer.
 * Returns `null` when the text is not a failure terminal line.
 */
export function rewriteSessionFailure(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const first = lines[0];
  if (!first || !SESSION_FAILURE_RE.test(first)) return null;
  const headline = scrubInternalJargon(first.replace(SESSION_FAILURE_RE, ""));
  const detail = lines
    .slice(1)
    .find((line) => !line.startsWith(TRIPLE_BACKTICK.slice(0, 1)) && !/\bexit\b/i.test(line));
  const combined = [headline, detail ? scrubInternalJargon(detail) : ""].filter(Boolean).join(" ");
  return combined || EVERYDAY.thread.internalToolActivity;
}

/**
 * Map any agent/team body to the text a customer may see. Never returns raw JSON, exit codes, or log output:
 *  - a team-event → its friendly, named, first-person line,
 *  - a `::team-event::` blob we could not parse → the brand-voice placeholder,
 *  - the runtime success terminal line (`✅ session completed (exit 0)`) → the placeholder (callers may drop it),
 *  - the runtime failure terminal line → honest plain language, no class tag or exit footer,
 *  - tool/runtime/log noise → the placeholder,
 *  - anything else → the text unchanged.
 */
export function customerVisibleAgentText(text: string): string {
  const event = parseTeamEvent(text);
  if (event) return teamEventFriendlyLine(event);
  if (text.trimStart().startsWith(TEAM_EVENT_MARKER)) return EVERYDAY.thread.internalToolActivity;
  if (isSessionOutcomeSuccessLine(text)) return EVERYDAY.thread.internalToolActivity;
  const failure = rewriteSessionFailure(text);
  if (failure) return failure;
  return looksLikeInternalActivity(text) ? EVERYDAY.thread.internalToolActivity : text;
}
