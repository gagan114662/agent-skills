/**
 * Injection-defense sanitizer for the Agent Garden surface (#284, ADR-0284, premortem #200 FM#6).
 *
 * Every free-text field the Garden projects to the client (and that flows into the #13 approval `summary`
 * the owner reads) is treated as untrusted **DATA**, never instructions. Today the agent contract metadata
 * is developer-authored, so this is defense-in-depth — but a future agent-authored or registry-sourced
 * contract field must never be able to inject the console, the audit feed, or the approval summary.
 *
 * The rule mirrors `agent-registry/a2a.ts sanitizeTask`: strip control characters, collapse whitespace, cap
 * length, and neutralize the instruction-frame markers a poisoned string would use to look like a directive
 * ("ignore previous", "system:", role tags). Pure + total — same input ⇒ same output.
 */

/** The longest a projected free-text field may be (a UI label / one-line summary, never a document). */
export const GARDEN_TEXT_MAX = 280;

/** Instruction-frame markers a poisoned metadata string would use to masquerade as a directive. */
const INSTRUCTION_FRAME_RE =
  /\b(?:ignore (?:all |the )?previous|disregard (?:all |the )?(?:previous|above)|system\s*:|assistant\s*:|developer\s*:|you are now|new instructions?)\b/gi;

/**
 * Replace every ASCII control char (C0 range 0x00–0x1F + DEL 0x7F) with a space. Done by codepoint, NOT a
 * regex — a `\x00`-class regex trips eslint `no-control-regex` and a literal control byte would be mangled
 * by an editor. Whitespace controls (tab/newline) are stripped here too; the caller collapses the result.
 */
function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

/**
 * Sanitize one free-text field for safe projection. Returns a single-line, length-capped, control-char-free
 * string with instruction-frame markers redacted to `[redacted]`. An empty/blank input yields `""`.
 */
export function sanitizeGardenText(input: unknown, max: number = GARDEN_TEXT_MAX): string {
  if (typeof input !== "string") return "";
  let s = stripControlChars(input)
    // Collapse runs of whitespace (incl. the unicode separators a string could smuggle) to one space.
    .replace(/\s+/g, " ")
    .trim();
  // Neutralize instruction-frame markers — the body is DATA, never a directive.
  s = s.replace(INSTRUCTION_FRAME_RE, "[redacted]");
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  return s;
}

/** Sanitize an array of free-text fields (capabilities, IO descriptions), dropping any that empty out. */
export function sanitizeGardenList(input: readonly unknown[], max: number = GARDEN_TEXT_MAX): string[] {
  return input.map((v) => sanitizeGardenText(v, max)).filter((s) => s.length > 0);
}
