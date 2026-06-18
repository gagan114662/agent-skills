/**
 * Oz-loops injection defense (#356, ADR-0356) — **pure**. These four loops (triage / spec / review /
 * pr-comment) ingest the most untrusted content the fleet sees: issue bodies, PR diffs, and review
 * comments written by anyone on the internet. The premortem (#200 §6) rule is absolute: that content is
 * **DATA, never instructions**. Nothing here lets ingested text redirect the agent, widen its scope, or
 * trigger an action — it is sanitized, length-capped, and (when it tries to give orders) FLAGGED so the
 * owner sees the attempt, but it is never followed.
 *
 * The decide functions read only STRUCTURAL signals (title keywords, file paths, diff `+/-` markers, label
 * hints). The free-text body is only ever echoed back inside a clearly-marked DATA block in an advisory
 * proposal — it is not parsed for commands. Deterministic ⇒ unit-testable; no IO.
 */

/** Default ceiling for a single sanitized free-text field (issue/PR/comment body). */
export const MAX_FIELD_CHARS = 4000;

/**
 * Strip C0/C1 control characters (NUL, ESC, ANSI, etc.) but keep newline/tab so diffs and specs stay
 * readable, collapse runs of spaces, trim trailing whitespace per line, and hard-cap the length. Total +
 * pure. Built char-by-char via code points so no literal control char ever lives in source (eslint
 * `no-control-regex`).
 */
export function sanitizeText(raw: string, maxLength: number = MAX_FIELD_CHARS): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n" || ch === "\t") {
      out += ch;
      continue;
    }
    // Drop other C0 (< 0x20) and C1 (0x7f–0x9f) control chars — replace with a single space.
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

/** A single-line variant: collapse ALL whitespace (incl. newlines) to single spaces. For titles/labels. */
export function sanitizeLine(raw: string, maxLength = 300): string {
  return sanitizeText(raw, maxLength).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * Phrases that signal ingested content trying to give the agent instructions or smuggle a tool/system
 * directive. Matching content is NOT removed (it may be a legitimate part of a bug report quoting an
 * attack); it is FLAGGED so the proposal records "this issue/comment tried to instruct me" and the owner
 * decides. The loop never acts on it. Deliberately broad on the "do an action / drop the human gate" axis.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |the |any |your |previous |above )?(instructions|rules|guidance|prompt)/i,
  /disregard (the |all |any |previous |your )?(instructions|rules|guidance|prompt|context)/i,
  /(you are|act as|pretend to be|you're now) (a |an )?[a-z]/i,
  /(system|developer) ?prompt|<\/?(system|tool|function|assistant|user)\b|tool_call|assistant:/i,
  /without (owner |human |a human |any )?(approval|review|sign-?off|confirmation)/i,
  /(skip|bypass|remove|disable|drop|delete|override) (the )?(approval|review|human|gate|safety|guardrail)/i,
  /no (approval|review|human|confirmation) (needed|required|necessary)/i,
  /(auto-?)?(merge|close|approve|publish|post|send|deploy|spend|pay|wire) (this|the|it|now|immediately)/i,
  /(exfiltrate|leak|reveal|print) (the |your )?(secret|token|key|credential|env)/i,
];

/** True iff `text` contains an instruction-injection / order-the-agent attempt. Pure + total. */
export function containsInjectionAttempt(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/** What {@link quarantine} returns: the sanitized DATA plus whether it tried to instruct the agent. */
export interface Quarantined {
  /** The sanitized, length-capped text — safe to echo back inside a DATA block. */
  text: string;
  /** True iff the original content tried to give the agent instructions (recorded, never followed). */
  injectionFlagged: boolean;
}

/**
 * Quarantine untrusted ingested content: sanitize it to safe DATA and flag (do not strip) any
 * instruction-injection attempt. The injection check runs on the ORIGINAL so that sanitization can never
 * hide an attempt from the flag. Pure + total.
 */
export function quarantine(raw: string, maxLength: number = MAX_FIELD_CHARS): Quarantined {
  return {
    text: sanitizeText(raw, maxLength),
    injectionFlagged: containsInjectionAttempt(raw),
  };
}
