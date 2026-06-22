/**
 * The pure draft composer (issue #595) — the heart of the LinkedIn outreach agent. Given a researched
 * {@link Prospect} and the sender {@link OutreachContext}, it produces a personalized, value-first
 * {@link OutreachDraft} for either kind. Pure and deterministic: same inputs ⇒ same output, no clock, no RNG,
 * no IO — so it is trivially unit-testable and reproducible.
 *
 * "Value-first" is structural here: a connection note leads with a specific personalization and a soft value
 * hook and NEVER a pitch/ask; a message offers the value proposition (and an optional resource) before a single
 * soft CTA. The composer reads prospect/context fields as DATA — it only concatenates them into the body, it
 * never lets a field decide control flow (#200 §6). Output is always clamped to the kind's character limit so a
 * draft is sendable as-is.
 */

import {
  CONNECTION_NOTE_MAX,
  MESSAGE_MAX,
  type OutreachContext,
  type OutreachDraft,
  type OutreachKind,
  type Prospect,
} from "./types.js";

/** Collapse internal whitespace and trim. Keeps drafts tidy when optional fields are absent. */
function tidy(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The greeting name: the first whitespace-delimited token of the prospect's name, or a neutral fallback. */
function firstName(name: string): string {
  const token = name.trim().split(/\s+/)[0];
  return token && token.length > 0 ? token : "there";
}

/**
 * The single highest-signal personalization line. Prefers the researched `hook`; otherwise derives a soft,
 * specific-enough opener from the prospect's role/company/industry; otherwise a neutral fallback. Returns a
 * clause that reads naturally after "I came across" / before the value line.
 */
function personalization(prospect: Prospect): string {
  const hook = prospect.hook?.trim();
  if (hook) return hook;
  const company = prospect.company?.trim();
  const title = prospect.title?.trim();
  if (company && title) return `your work as ${title} at ${company}`;
  if (company) return `the team at ${company}`;
  if (title) return `your work as ${title}`;
  const industry = prospect.industry?.trim();
  if (industry) return `your work in ${industry}`;
  return "your work";
}

/** Clamp `body` to `max` characters, appending an ellipsis when it overflows (preferring a word boundary). */
function clamp(body: string, max: number): { body: string; truncated: boolean } {
  if (body.length <= max) return { body, truncated: false };
  const hardCut = body.slice(0, max - 1);
  const lastSpace = hardCut.lastIndexOf(" ");
  // Only break on a word boundary if it does not throw away too much of the note.
  const base = lastSpace > max * 0.6 ? hardCut.slice(0, lastSpace) : hardCut;
  return { body: `${base.trimEnd()}…`, truncated: true };
}

/**
 * Compose a connection-request note: a short, value-first invite that personalizes, offers a soft value hook,
 * and asks only to connect (no pitch). Clamped to {@link CONNECTION_NOTE_MAX}.
 */
function composeConnection(prospect: Prospect, context: OutreachContext): OutreachDraft {
  const greeting = `Hi ${firstName(prospect.name)},`;
  const opener = `I came across ${personalization(prospect)} and wanted to reach out.`;
  // Value-first hook, no ask: frame the value proposition as something potentially useful to THEM.
  const value = `I'm with ${context.senderCompany} — we're working on ${context.valueProposition}, which felt relevant.`;
  const close = "Would love to connect.";
  const full = tidy(`${greeting} ${opener} ${value} ${close}`);
  const { body, truncated } = clamp(full, CONNECTION_NOTE_MAX);
  return { kind: "connection", body, charCount: body.length, truncated };
}

/**
 * Compose a value-first message: a personalized opener, the value proposition offered up front, an optional
 * concrete resource, then a single soft CTA, signed by the sender. Clamped to {@link MESSAGE_MAX}.
 */
function composeMessage(prospect: Prospect, context: OutreachContext): OutreachDraft {
  const greeting = `Hi ${firstName(prospect.name)},`;
  const opener = `I came across ${personalization(prospect)}.`;
  const value = `We've been putting together ${context.valueProposition} and I thought it might be genuinely useful to you — no pitch.`;
  const resource = context.resourceRef?.trim()
    ? `Happy to share it directly: ${context.resourceRef.trim()}.`
    : "";
  const cta = context.callToAction?.trim() || "Open to a quick swap of notes if it's relevant?";
  const sign = `— ${context.senderName}, ${context.senderCompany}`;
  const full = tidy(`${greeting}\n\n${opener} ${value} ${resource}\n\n${cta}\n\n${sign}`);
  const { body, truncated } = clamp(full, MESSAGE_MAX);
  return { kind: "message", body, charCount: body.length, truncated };
}

/**
 * Compose a personalized, value-first draft of `kind` for `prospect` grounded in `context`. The pure entry
 * point the service calls before queueing a touch.
 */
export function composeOutreach(
  kind: OutreachKind,
  prospect: Prospect,
  context: OutreachContext,
): OutreachDraft {
  return kind === "connection"
    ? composeConnection(prospect, context)
    : composeMessage(prospect, context);
}
