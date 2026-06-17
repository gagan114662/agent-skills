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

/** First non-empty line of the draft, trimmed + truncated, for the card preview. `""` when no draft. */
export function deliverablePreview(draft: string | undefined | null): string {
  if (!draft) return "";
  const firstLine = draft
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  return truncateByCodePoints(firstLine, 120);
}
