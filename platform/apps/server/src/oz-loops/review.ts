/**
 * Code-review loop (#356, ADR-0356) — **pure**, adapted from oz-for-oss's `review-pr` / `verify-pr` skills.
 * Reads an untrusted unified diff STRUCTURALLY (only `+`/`-`/path markers) and emits ADVISORY
 * {@link ReviewFinding}s plus a suggested verdict. It NEVER approves, requests changes on GitHub, or merges
 * — the verdict is a suggestion the owner acts on through #13. The diff is quarantined DATA: an
 * instruction-injection attempt embedded in it is flagged, not followed (#200 §6). Deterministic; no IO.
 */
import type { ReviewFinding, ReviewInput, ReviewProposal, ReviewVerdict } from "./contract.js";
import { containsInjectionAttempt, sanitizeLine, sanitizeText } from "./sanitize.js";

/** Tunable bounds for a review pass. */
export interface ReviewOptions {
  /** Cap on emitted findings (the rest are summarized as "+N more"). Default 25. */
  maxFindings?: number;
  /** Cap on diff chars scanned (a huge diff is truncated — flagged as a finding). Default 200_000. */
  maxDiffChars?: number;
  /** Added-line count above which the PR is flagged "large". Default 600. */
  largeDiffThreshold?: number;
}

/** Patterns on ADDED lines that warrant a warning-level finding. */
const ADDED_LINE_RULES: readonly { rule: string; severity: "warning" | "info"; re: RegExp; message: string }[] = [
  { rule: "debug-artifact", severity: "warning", re: /\b(console\.(log|debug)|debugger\b|System\.out\.print|fmt\.Println|binding\.pry)\b/, message: "debug artifact left in code" },
  { rule: "todo-marker", severity: "info", re: /\b(TODO|FIXME|XXX|HACK)\b/, message: "TODO/FIXME marker added" },
  { rule: "possible-secret", severity: "warning", re: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i, message: "possible hard-coded secret" },
  { rule: "focused-test", severity: "warning", re: /\b(\.only\(|fdescribe\(|fit\()/, message: "focused test (.only/fit) will skip the rest of the suite" },
];

/** A file is a "test file" by path convention. */
function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)\//.test(path) || /\.(test|spec)\.[a-z]+$/i.test(path);
}

/** A file is reviewable source (not lockfile/asset/config noise) for the missing-tests heuristic. */
function isSourceFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|py|go|rs|java|rb|c|cc|cpp|cs)$/i.test(path) && !isTestFile(path);
}

/** Pull the `b/` path out of a `diff --git` / `+++ b/...` header line. */
function pathFromHeader(line: string): string | null {
  const git = /^diff --git a\/\S+ b\/(\S+)/.exec(line);
  if (git?.[1]) return git[1];
  const plus = /^\+\+\+ b\/(.+)$/.exec(line);
  if (plus?.[1] && plus[1] !== "/dev/null") return plus[1].trim();
  return null;
}

/**
 * Decide an advisory review from a diff. Pure: same diff ⇒ same proposal. A finding is raised at most once
 * per (rule, file). The verdict is the strongest signal seen: any warning ⇒ `needs_changes`, only info ⇒
 * `comment`, nothing ⇒ `looks_good` — a SUGGESTION, never an authority to merge.
 */
export function decideReview(input: ReviewInput, opts: ReviewOptions = {}): ReviewProposal {
  const maxFindings = opts.maxFindings ?? 25;
  const maxDiffChars = opts.maxDiffChars ?? 200_000;
  const largeDiffThreshold = opts.largeDiffThreshold ?? 600;

  const rawDiff = input.diff ?? "";
  const truncated = rawDiff.length > maxDiffChars;
  const diff = sanitizeText(rawDiff, maxDiffChars);
  const injectionFlagged = containsInjectionAttempt(rawDiff);

  const findings: ReviewFinding[] = [];
  const seen = new Set<string>();
  const push = (f: ReviewFinding) => {
    const key = `${f.rule}::${f.file ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ ...f, message: sanitizeLine(f.message, 200) });
  };

  let currentFile: string | null = null;
  let addedLines = 0;
  const changedSet = new Set(input.changedFiles ?? []);

  for (const line of diff.split("\n")) {
    const header = pathFromHeader(line);
    if (header) {
      currentFile = header;
      changedSet.add(header);
      continue;
    }
    // Only ADDED lines (single leading '+', not the '+++' header) are scrutinized.
    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLines++;
      const added = line.slice(1);
      for (const rule of ADDED_LINE_RULES) {
        if (rule.re.test(added)) {
          push({ rule: rule.rule, severity: rule.severity, message: rule.message, file: currentFile ?? undefined });
        }
      }
    }
  }

  if (addedLines > largeDiffThreshold) {
    push({ rule: "large-diff", severity: "info", message: `large diff (${addedLines} added lines) — consider splitting` });
  }
  if (truncated) {
    push({ rule: "diff-truncated", severity: "info", message: `diff exceeded ${maxDiffChars} chars and was truncated for review` });
  }
  // Missing-tests heuristic: source files changed but no test file in the change set.
  const allFiles = [...changedSet];
  const touchedSource = allFiles.some(isSourceFile);
  const touchedTest = allFiles.some(isTestFile);
  if (touchedSource && !touchedTest && allFiles.length > 0) {
    push({ rule: "missing-tests", severity: "warning", message: "source changed but no test file was added or modified" });
  }
  if (injectionFlagged) {
    push({ rule: "injection-attempt", severity: "info", message: "diff content tried to instruct the agent — treated as DATA, not followed" });
  }

  const overflow = findings.length > maxFindings ? findings.length - maxFindings : 0;
  const shown = findings.slice(0, maxFindings);

  const hasWarning = shown.some((f) => f.severity === "warning");
  const verdict: ReviewVerdict = hasWarning ? "needs_changes" : shown.length > 0 ? "comment" : "looks_good";

  const summaryTail =
    verdict === "looks_good"
      ? "no structural issues found"
      : `${shown.length} finding(s)${overflow ? ` (+${overflow} more)` : ""}`;

  return {
    kind: "review",
    advisory: true,
    injectionFlagged,
    findings: shown,
    verdict,
    summary: sanitizeLine(`Review PR #${input.prNumber}: ${verdict} — ${summaryTail}`, 200),
  };
}
