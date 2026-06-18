/**
 * Pure composition of a coordination event into a text-only channel message (#370, ADR-0370). Every
 * free-text field is UNTRUSTED DATA (#200 §6): {@link sanitizeData} strips control characters, collapses
 * whitespace, and hard-caps the length so a crafted goal/task/title/summary can neither inject control
 * sequences nor flood a channel. The agent voice around the DATA is FIXED (it is the bridge's own framing,
 * not model output), and the message renders as React text only (no `dangerouslySetInnerHTML` — already
 * true in `MessagePane`), so a `@mention` or `#13` in the DATA is inert text, never a directive.
 *
 * Pure ⇒ every branch is unit-tested without a DB or a DOM.
 */
import type { ComposeContext, ComposedPost, CoordinationEvent } from "./events.js";

/** Hard cap on any single embedded DATA field (a channel line, not an essay). */
export const MAX_DATA_CHARS = 280;

/** Hard cap on a short id rendered into a task/approval reference. */
const MAX_ID_CHARS = 64;

/**
 * Sanitize an untrusted free-text field for display in a channel message. Drops C0/C1 control characters
 * (so no ANSI / newline injection into the rendered line), collapses runs of whitespace, trims, and caps
 * the length. Mirrors `agent-registry/a2a.ts#sanitizeTask` — the same DATA-handling discipline.
 */
export function sanitizeData(text: string, maxChars: number = MAX_DATA_CHARS): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += " ";
    } else {
      out += ch;
    }
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > maxChars ? `${out.slice(0, maxChars).trim()}…` : out;
}

/** A structural id rendered into a reference (ids are not free text, but we still bound + strip them). */
function sanitizeId(id: string): string {
  return sanitizeData(id, MAX_ID_CHARS);
}

/**
 * Turn a coordination event into a text-only post. Returns the channel + author handle the dispatcher
 * resolves, and the fixed-voice body with the sanitized DATA embedded.
 */
export function composePost(event: CoordinationEvent, ctx: ComposeContext = {}): ComposedPost {
  switch (event.kind) {
    case "lead_plan": {
      const goal = sanitizeData(event.goal);
      return {
        channel: event.channel,
        authorHandle: event.agentHandle,
        body:
          `Picking this up. Goal: “${goal}”. I'll plan the work here in #${event.channel} and post ` +
          `progress as I go — anything that leaves the building stops at the #13 approval gate first.`,
      };
    }
    case "handoff": {
      const task = sanitizeData(event.task);
      return {
        channel: event.channel,
        authorHandle: event.agentHandle,
        body: `Handing this off to @${event.toHandle}: ${task}`,
      };
    }
    case "task_created": {
      const title = sanitizeData(event.title);
      const ref = sanitizeId(event.taskId);
      const assignee = event.assigneeHandle ? ` → @${event.assigneeHandle}` : "";
      return {
        channel: event.channel,
        authorHandle: event.agentHandle,
        body: `📋 Task ${ref}: ${title}${assignee}`,
      };
    }
    case "approval_required": {
      const summary = sanitizeData(event.summary);
      const ref = sanitizeId(event.approvalRequestId);
      const mention = ctx.ownerName ? `@${ctx.ownerName} ` : "";
      return {
        channel: event.channel,
        authorHandle: event.agentHandle,
        body:
          `${mention}this needs a human OK before it leaves the building: ${summary}. ` +
          `Surfacing the existing #13 approval gate (request ${ref}) — not a new action.`,
      };
    }
  }
}
