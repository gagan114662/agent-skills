/**
 * Pure helpers for @mention autocomplete in the composer. Mirrors the server's handle rules
 * (`apps/server/src/messaging/mentions.ts`): a handle is `@` + `[A-Za-z0-9._-]+`, and the `@`
 * must not be preceded by a word char (so `user@host` is not a mention trigger).
 */

const HANDLE_CHAR = /[A-Za-z0-9._-]/;
const WORD_CHAR = /\w/;

/** Index of the `@` that starts the active mention token at `caret`, or null if none is active. */
function mentionStart(text: string, caret: number): number | null {
  let i = caret - 1;
  while (i >= 0 && HANDLE_CHAR.test(text[i] ?? "")) i -= 1;
  if (i < 0 || text[i] !== "@") return null;
  const before = i > 0 ? (text[i - 1] ?? "") : "";
  if (before && WORD_CHAR.test(before)) return null;
  return i;
}

/**
 * The partial handle currently being typed at `caret`, or null if the caret is not inside a
 * mention token. An empty string means a bare `@` was just typed (autocomplete should show all).
 */
export function activeMentionQuery(text: string, caret: number): string | null {
  const start = mentionStart(text, caret);
  if (start === null) return null;
  return text.slice(start + 1, caret);
}

/** Replace the active mention token with `@displayName ` and return the new text + caret. */
export function applyMentionSelection(
  text: string,
  caret: number,
  displayName: string,
): { text: string; caret: number } {
  const start = mentionStart(text, caret);
  if (start === null) return { text, caret };
  const after = text.slice(caret);
  const trailing = after.startsWith(" ") ? "" : " ";
  const insert = `@${displayName}${trailing}`;
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length };
}
