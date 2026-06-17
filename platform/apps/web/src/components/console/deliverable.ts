/**
 * Pure deliverable presentation (#302). A completed agent session surfaces on the board as an
 * `agent.deliverable` approval card. Server-side the summary is `"Deliverable ready for review: <raw
 * prompt>"` and the chip is the raw `agent.deliverable` type id — both leak internals and read wrong on a
 * Done card. This module turns the raw approval into the three things a card needs:
 *
 *   · a HUMAN title — the work itself, cleaned of the boilerplate prefix, URLs, and "fetch …" tails, so
 *     the sidebar shows a distinct name per item (not the identical truncated "Deliverable rea…");
 *   · a PREVIEW — the first line of what the agent actually produced (the draft tail);
 *   · a CONSEQUENCE — a plain "what happens if I approve" line while it awaits review.
 *
 * It also recognises internal / test / dogfood deliverables (e.g. "Reply with one sentence confirming you
 * can run, then stop") so they can be filtered out of a real customer workspace, and maps every action
 * type to a human label so a raw `x.y` id never renders anywhere.
 *
 * Logic-only, save for one brand-sourced map (`humanActionLabel`): the components/model own the rest of
 * the voice via `brand.ts`. No copy is inlined here.
 */
import { CONSOLE } from "../../brand.js";

/** The internal action type a completed session's review card carries (#248). Never rendered raw. */
export const DELIVERABLE_ACTION = "agent.deliverable";

/**
 * Phrases that mark a deliverable as an internal QA / dogfood / smoke task — never a real customer
 * deliverable (#302). Matched case-insensitively against the task prompt. Kept deliberately narrow so a
 * legitimate customer task is never hidden: these are connectivity / "can you run" probes, not work.
 */
const INTERNAL_MARKERS = [
  "reply with one sentence confirming you can run",
  "confirm you can run, then stop",
  "confirm you can run then stop",
  "reply with one sentence",
  "say ready and stop",
  "respond with ok and stop",
  "this is a smoke test",
  "ping test",
];

/**
 * Human label for an action type — the brand-mapped name, or a generic fallback (#302). NEVER returns the
 * raw `x.y` type id, so an internal id like `agent.deliverable` can never surface in a user workspace.
 */
export function humanActionLabel(actionType: string | undefined | null): string {
  if (!actionType) return CONSOLE.deliverable.actionFallback;
  return CONSOLE.deliverable.actionLabels[actionType] ?? CONSOLE.deliverable.actionFallback;
}

/** Strip the server's "Deliverable ready for review:" boilerplate prefix if present. */
function stripReviewPrefix(text: string): string {
  return text.replace(/^\s*deliverable ready for review:\s*/i, "");
}

/**
 * Leading harness / CLI noise the runtime captures ahead of the real output. When a fleet session shells
 * out to the agent CLI (`claude -p` / `codex exec`) with a connected-but-empty stdin pipe, the CLI waits
 * a few seconds then prints `Warning: no stdin data received in 3s, proceeding without it. If piping from
 * a slow command, redirect stdin explicitly:` (plus its example line) to stderr — BEFORE any real work.
 * The runtime captures stderr into the result tail, so that warning becomes the first line of the stored
 * draft and renders as the card summary. The invocation is fixed at the source (the CLI's stdin is now
 * redirected from /dev/null), but these patterns let the renderer also clean drafts captured BEFORE that
 * fix, so historical cards show real content with no data migration.
 *
 * Every pattern is ANCHORED to the start of the (trimmed) line and matches only the exact CLI warning
 * lines — never a substring mid-line. An earlier un-anchored `| claude` pattern wrongly matched a genuine
 * Markdown table row such as `| Claude | OpenAI |`, corrupting real content; anchoring fixes that.
 */
const HARNESS_NOISE_PATTERNS: readonly RegExp[] = [
  // The stdin warning itself (one line): "Warning: no stdin data received in 3s, proceeding without it…".
  /^warning: no stdin data received\b/i,
  // Its redirect-instruction continuation, when the CLI prints it on its own line.
  /^(?:if piping from a slow command, )?redirect stdin explicitly:?\s*$/i,
  // The piping EXAMPLE the warning prints, e.g. "cat input.txt | claude -p" — anchored to a leading
  // shell command so a Markdown table row ("| Claude | OpenAI |") is never mistaken for it.
  /^(?:cat|echo|printf)\b.*\|\s*(?:claude|codex)\b/i,
];

/** True when a single line reads as captured harness/CLI noise (never genuine deliverable content). */
function isHarnessNoiseLine(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && HARNESS_NOISE_PATTERNS.some((re) => re.test(t));
}

/**
 * Drop LEADING harness/CLI noise lines (and the blank gaps around them) from captured agent output so the
 * real deliverable surfaces. Only the leading region is cleaned — once the first line of genuine content
 * is reached everything after it is preserved verbatim, so a later line that merely resembles the warning
 * (e.g. the agent quoting it) is never removed. Pure; returns "" for empty/nullish input, and the original
 * trimmed text if the whole string was noise/blank (so a draft is never blanked out entirely).
 */
export function stripHarnessNoise(text: string | undefined | null): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (isHarnessNoiseLine(lines[i] ?? "") || (lines[i] ?? "").trim() === "")) {
    i++;
  }
  if (i >= lines.length) return text.trim();
  return lines.slice(i).join("\n");
}

/** True when this deliverable's task text reads as an internal / test / dogfood probe (#302). */
export function isInternalDeliverableTask(task: string | undefined | null): boolean {
  if (!task) return false;
  const t = stripReviewPrefix(task).toLowerCase();
  return INTERNAL_MARKERS.some((m) => t.includes(m));
}

/**
 * Best-effort human title for a deliverable, derived from the agent's task prompt. Strips the boilerplate
 * prefix, cuts everything from the first URL or "fetch …" onward (those are mechanics, not the headline),
 * collapses whitespace, sentence-cases the first letter, and truncates. Returns `""` when nothing usable
 * is left so the caller can fall back to a brand string.
 */
export function cleanDeliverableTitle(task: string | undefined | null): string {
  if (!task) return "";
  let t = stripReviewPrefix(task);
  // Cut at the first URL / "fetch http…" — keep only the human description before the mechanics.
  t = t.replace(/\b(?:fetch\s+)?https?:\/\/\S+.*$/i, "");
  t = t.replace(/\bfetch\b.*$/i, "");
  // Collapse whitespace (incl. any stray control chars) and trim trailing punctuation/ellipses.
  t = t.replace(/\s+/g, " ").trim().replace(/[\s.…]+$/u, "");
  if (!t) return "";
  // Sentence-case the first letter; leave the rest as the agent wrote it.
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return truncateByCodePoints(t, 64);
}

/**
 * Truncate to at most `max` Unicode code points, never splitting a surrogate pair (an emoji / astral char
 * at the boundary stays whole — `str.slice` counts UTF-16 units and would emit a lone surrogate). When
 * truncation happens, the last kept code point is replaced by an ellipsis (keeping the length at `max`).
 */
function truncateByCodePoints(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/**
 * First non-empty line of the draft, trimmed + truncated, for the card preview. Leading harness/CLI noise
 * (the captured stdin warning) is stripped first so the preview is the agent's real output, not a log
 * line. `""` when no draft (or nothing but noise).
 */
export function deliverablePreview(draft: string | undefined | null): string {
  if (!draft) return "";
  const firstLine = stripHarnessNoise(draft)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  return truncateByCodePoints(firstLine, 120);
}
