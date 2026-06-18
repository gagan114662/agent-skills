/**
 * Issue-triage loop (#356, ADR-0356) — **pure**, adapted from oz-for-oss's `triage-issue` /
 * `dedupe-issue` skills. Turns an untrusted issue into an ADVISORY {@link TriageProposal}: suggested
 * labels, a severity, and likely-duplicate references. It NEVER applies a label, routes, or closes — the
 * owner does, through #13. Only STRUCTURAL signals drive the decision (title/body keywords, label hints,
 * title token overlap); the body is quarantined DATA and any instruction-injection attempt is flagged, not
 * followed (#200 §6). Deterministic ⇒ unit-testable; no IO.
 */
import type { TriageInput, TriageProposal, TriageSeverity } from "./contract.js";
import { quarantine, sanitizeLine } from "./sanitize.js";

/** Keyword → label rules. Matched case-insensitively against the sanitized title+body DATA. */
const LABEL_RULES: readonly { label: string; re: RegExp }[] = [
  { label: "bug", re: /\b(bug|crash|broken|error|exception|stack ?trace|regression|fails?|failing)\b/i },
  { label: "enhancement", re: /\b(feature|enhancement|add support|would be nice|please add|propose)\b/i },
  { label: "security", re: /\b(security|vulnerab|cve|exploit|xss|csrf|injection|rce|leak(ed)? (a )?(secret|token|key))\b/i },
  { label: "documentation", re: /\b(docs?|documentation|readme|typo|wording|clarif)\b/i },
  { label: "performance", re: /\b(slow|performance|latency|timeout|memory leak|cpu|too slow)\b/i },
  { label: "question", re: /\b(how do i|how to|question|is it possible|can i)\b/i },
];

/** Severity rules, highest first — the first match wins. */
const SEVERITY_RULES: readonly { severity: Exclude<TriageSeverity, "unknown">; re: RegExp }[] = [
  { severity: "high", re: /\b(security|vulnerab|cve|exploit|rce|data ?loss|production down|outage|crash(es|ed|ing)?|cannot (log ?in|deploy|build))\b/i },
  { severity: "medium", re: /\b(bug|error|broken|fails?|failing|regression|incorrect|wrong)\b/i },
  { severity: "low", re: /\b(typo|docs?|wording|cosmetic|nit|minor|question|how to)\b/i },
];

/** Stop-words ignored when comparing issue titles for duplicate detection. */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "are", "be", "with",
  "when", "from", "by", "it", "this", "that", "not", "no", "i", "we", "you", "add", "fix",
]);

/** Significant lowercase tokens of a title (stop-words + short tokens dropped). Pure. */
function titleTokens(title: string): Set<string> {
  return new Set(
    sanitizeLine(title)
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
  );
}

/** Jaccard overlap of two token sets in [0, 1]. Pure + total (empty sets ⇒ 0). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Min title-token overlap to call two issues likely duplicates. Conservative to avoid false "close it". */
const DUPLICATE_THRESHOLD = 0.5;

/**
 * Decide an advisory triage for an issue. Pure: same input ⇒ same proposal. Labels already present are not
 * re-suggested. Duplicate detection is title-token overlap only (the loop never auto-closes a "duplicate").
 */
export function decideTriage(input: TriageInput): TriageProposal {
  const title = sanitizeLine(input.title);
  const body = quarantine(input.body);
  const hay = `${title}\n${body.text}`;
  const existing = new Set((input.existingLabels ?? []).map((l) => l.toLowerCase()));

  const suggestedLabels = LABEL_RULES.filter((r) => r.re.test(hay) && !existing.has(r.label)).map(
    (r) => r.label,
  );

  let severity: TriageSeverity = "unknown";
  for (const rule of SEVERITY_RULES) {
    if (rule.re.test(hay)) {
      severity = rule.severity;
      break;
    }
  }

  const myTokens = titleTokens(title);
  const likelyDuplicateOf = (input.openIssues ?? [])
    .filter((other) => other.number !== input.number)
    .filter((other) => jaccard(myTokens, titleTokens(other.title)) >= DUPLICATE_THRESHOLD)
    .map((other) => other.number);

  const rationaleParts = [
    suggestedLabels.length ? `labels: ${suggestedLabels.join(", ")}` : "no label match",
    `severity: ${severity}`,
    likelyDuplicateOf.length ? `possible duplicate of #${likelyDuplicateOf.join(", #")}` : "no duplicate match",
  ];
  if (body.injectionFlagged) {
    rationaleParts.push("⚠ issue body tried to instruct the agent — treated as DATA, not followed");
  }

  return {
    kind: "triage",
    advisory: true,
    injectionFlagged: body.injectionFlagged,
    suggestedLabels,
    severity,
    likelyDuplicateOf,
    rationale: sanitizeLine(rationaleParts.join("; "), 500),
    summary: sanitizeLine(`Triage #${input.number} "${title}" → ${rationaleParts.slice(0, 2).join("; ")}`, 200),
  };
}
