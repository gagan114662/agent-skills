/**
 * Pure prompt-injection DETECTOR for externally-fetched content (issue #674). Given a blob of attacker-
 * controlled text it returns the injection signals it carries and an overall severity. It does NOT decide
 * what to do about them — that is the gate's job (`content-guard/gate.ts`). Detection is advisory evidence;
 * it raises the alarm and feeds the approval UI, but the safety property (no autonomous action on external
 * content) does NOT depend on the detector catching every attack. A novel injection the detector misses is
 * still fenced as DATA by the neutralizer and still forced through the human gate — detection only escalates
 * how loudly we warn and whether we hard-block (see `caps.ts`).
 *
 * Pure + total: a single `string` in, a structured scan out. No IO, no clock, no model call — so it runs in
 * the offline unit job and is deterministic. Designed to OVER-report rather than under-report (favouring
 * false positives) because every signal only ever ADDS caution; nothing here can declassify content.
 *
 * The patterns target the well-known families: instruction-override, role/system spoofing, tool-call
 * mimicry, data exfiltration, fake-authorization ("the user already approved this"), and hidden-character
 * smuggling (zero-width / Unicode-tag / bidi-override characters that hide text from a human reviewer).
 */

/** The kinds of injection signal we recognize. Ordered roughly most-dangerous first. */
export const INJECTION_KINDS = [
  "instruction-override",
  "role-injection",
  "tool-invocation",
  "data-exfiltration",
  "fake-authorization",
  "hidden-characters",
  "fence-breakout",
] as const;
export type InjectionKind = (typeof INJECTION_KINDS)[number];

export type Severity = "none" | "low" | "medium" | "high";

const SEVERITY_RANK: Record<Severity, number> = { none: 0, low: 1, medium: 2, high: 3 };

/** The more severe of two severities. */
export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** One matched injection signal: its family, a human-readable label, the offending excerpt, and how bad it is. */
export interface InjectionSignal {
  kind: InjectionKind;
  severity: Exclude<Severity, "none">;
  /** A short description of what was matched (safe to show a human; the excerpt is included separately). */
  label: string;
  /** The matched substring, truncated — useful for an approval UI. May itself be hostile; render as data. */
  excerpt: string;
}

/** The result of scanning a blob of untrusted text. */
export interface InjectionScan {
  /** True if ANY signal fired. */
  detected: boolean;
  /** The single worst severity across all signals (`none` when nothing fired). */
  severity: Severity;
  /** Every signal that fired, in detection order. */
  signals: InjectionSignal[];
}

interface PatternRule {
  kind: InjectionKind;
  severity: Exclude<Severity, "none">;
  label: string;
  pattern: RegExp;
}

/**
 * The signature table. Each entry is a case-insensitive pattern; the regexes are deliberately broad so a
 * lightly-obfuscated phrase still trips them. (Whitespace classes use `\s+` so "ignore   previous" and
 * line-wrapped variants match.)
 */
const RULES: PatternRule[] = [
  // --- instruction-override: the classic "forget what you were told" family -------------------------------
  {
    kind: "instruction-override",
    severity: "high",
    label: "attempt to override prior instructions",
    pattern: /\b(ignore|disregard|forget|override|bypass)\b[\s\S]{0,40}?\b(all\s+)?(previous|prior|above|earlier|preceding|system|your)\b[\s\S]{0,20}?\b(instruction|prompt|rule|directive|context|message)/i,
  },
  {
    kind: "instruction-override",
    severity: "high",
    label: "instruction to discard guardrails / restrictions",
    pattern: /\b(ignore|disregard|drop|lift|remove)\b[\s\S]{0,30}?\b(restriction|guard\s?rail|safety|policy|filter|limitation)/i,
  },
  // --- role/system spoofing: pretending to be a system or developer turn ----------------------------------
  {
    kind: "role-injection",
    severity: "high",
    label: "spoofed system/developer role marker",
    pattern: /(^|\n)\s*(#{0,3}\s*)?(system|developer|assistant)\s*[:>\]]/i,
  },
  {
    kind: "role-injection",
    severity: "medium",
    label: "identity-reassignment ('you are now …')",
    pattern: /\byou\s+are\s+(now|actually|really)\b|\bfrom\s+now\s+on\b[\s\S]{0,30}?\byou\b|\bact\s+as\b[\s\S]{0,20}?\b(an?\s+)?(unrestricted|jailbroken|dan|developer\s+mode)/i,
  },
  // --- tool-invocation mimicry: text that imitates a tool/function call -----------------------------------
  {
    kind: "tool-invocation",
    severity: "high",
    label: "embedded tool/function-call directive",
    pattern: /\b(call|invoke|execute|run|use)\b[\s\S]{0,24}?\b(tool|function|command|api|endpoint|shell|bash)\b|<\/?(tool_call|function_call|invoke)\b|```\s*(tool|function|json)\b[\s\S]{0,40}?(tool|function|call)/i,
  },
  // --- data exfiltration: get secrets or page contents sent somewhere --------------------------------------
  {
    kind: "data-exfiltration",
    severity: "high",
    label: "request to reveal secrets / system prompt",
    pattern: /\b(reveal|show|print|repeat|disclose|leak|dump|send)\b[\s\S]{0,30}?\b(system\s+prompt|instructions|api[\s_-]?key|secret|password|token|credential|env(ironment)?\s+var)/i,
  },
  {
    kind: "data-exfiltration",
    severity: "high",
    label: "instruction to send/POST data to an external destination",
    pattern: /\b(send|post|upload|exfiltrate|forward|email|transmit)\b[\s\S]{0,40}?\b(to\s+)?(https?:\/\/|www\.|[\w.+-]+@[\w-]+\.)/i,
  },
  {
    kind: "data-exfiltration",
    severity: "medium",
    label: "markdown image/link with interpolated data (exfil vector)",
    pattern: /!?\[[^\]]*\]\(\s*https?:\/\/[^)\s]*\{[^}]+\}/i,
  },
  // --- fake authorization: claiming the human already approved --------------------------------------------
  {
    kind: "fake-authorization",
    severity: "high",
    label: "forged approval / authorization claim",
    pattern: /\b(the\s+)?(user|owner|admin|human)\b[\s\S]{0,24}?\b(has\s+)?(already\s+)?(approved|authorized|confirmed|permitted|allowed)\b|\b(no|without)\b[\s\S]{0,16}?\b(approval|confirmation|permission)\b[\s\S]{0,16}?\b(needed|required|necessary)|\bthis\s+is\s+(pre[\s-]?)?(authorized|approved)\b/i,
  },
];

/**
 * The set of invisible / format / bidi code-point ranges used to smuggle hidden instructions past a human
 * reviewer. Built programmatically from explicit code points so no actual invisible character ever lives in
 * this source file. Covers: zero-width chars + RTL/LTR marks (U+200B–U+200F), bidi embeddings/overrides
 * (U+202A–U+202E), word-joiner / invisible math operators (U+2060–U+2064), deprecated format chars
 * (U+206A–U+206F), the BOM / zero-width no-break space (U+FEFF), and the Unicode "tag" block used to encode
 * hidden ASCII (U+E0000–U+E007F).
 */
const HIDDEN_CHAR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x206a, 0x206f],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

const HIDDEN_CHARS = new RegExp(`[${hiddenCharClass(HIDDEN_CHAR_RANGES)}]`, "u");

/** Build a RegExp character-class body from code-point ranges using `\u{…}` escapes (no literal invisibles). */
function hiddenCharClass(ranges: ReadonlyArray<readonly [number, number]>): string {
  const esc = (cp: number): string => "\\u{" + cp.toString(16) + "}";
  return ranges.map(([lo, hi]) => (lo === hi ? esc(lo) : esc(lo) + "-" + esc(hi))).join("");
}

/** Truncate an excerpt for display; hostile content stays hostile, so callers must still render it as data. */
function excerpt(value: string, max = 120): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/**
 * Scan untrusted text for injection signals. Pure + total. Returns every signal that fired plus the worst
 * severity; an empty/whitespace/non-string input scans clean. Over-reports by design — a signal can only
 * raise caution downstream, never lower it.
 */
export function detectInjection(text: string): InjectionScan {
  const signals: InjectionSignal[] = [];
  if (typeof text !== "string" || text.length === 0) {
    return { detected: false, severity: "none", signals };
  }

  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      signals.push({
        kind: rule.kind,
        severity: rule.severity,
        label: rule.label,
        excerpt: excerpt(match[0]),
      });
    }
  }

  if (HIDDEN_CHARS.test(text)) {
    signals.push({
      kind: "hidden-characters",
      severity: "high",
      label: "hidden/invisible characters (zero-width, Unicode-tag, or bidi override)",
      excerpt: "<non-printing characters detected>",
    });
  }

  const severity = signals.reduce<Severity>((acc, s) => maxSeverity(acc, s.severity), "none");
  return { detected: signals.length > 0, severity, signals };
}
