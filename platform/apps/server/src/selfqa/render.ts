import type { FailureEvent } from "../flywheel/types.js";
import { normalizeActual } from "./fingerprint.js";
import type { QaFinding, QaRunSummary, QaSuite, RawCheckResult } from "./types.js";

/**
 * Owner-quality issue rendering for the Self-QA Loop (#171, ADR-0171). **Pure**, and every render site
 * reads only already-scrubbed fields — the failure detail is normalized (volatile tokens removed) and
 * evidence paths have their query strings stripped, so a secret has no path into a GitHub issue body.
 *
 * The output is shaped like the owner's own report (#166–#169): grouped by surface, with numbered repro,
 * expected-vs-actual, acceptance criteria, and severity labels. A machine-readable dedup marker is
 * embedded so the stateless CI reporter can find the existing issue for a recurring finding (the #108
 * uptime pattern) and comment instead of opening a duplicate.
 */

/** The HTML-comment dedup marker embedded in every issue body (parsed back out by the CI reporter). */
export function selfqaMarker(signature: string): string {
  return `<!-- selfqa:${signature} -->`;
}

const MARKER_RE = /<!--\s*selfqa:([0-9a-f]{16})\s*-->/;

/** Extract the self-QA dedup signature from an existing issue body, or null if it carries none. */
export function parseSelfqaMarker(body: string): string | null {
  return MARKER_RE.exec(body)?.[1] ?? null;
}

/** The issue title — grouped by surface so the owner can triage by area at a glance. */
export function renderFindingTitle(f: QaFinding): string {
  return `[self-qa:${f.surface}] ${f.title}`;
}

/** Triage labels: the loop tag, the surface group, and the severity (matches the owner's report). */
export function findingLabels(f: QaFinding): string[] {
  return ["selfqa", `selfqa:${f.surface}`, `severity:${f.severity}`];
}

/** Strip any query string / fragment off an evidence path so no token-bearing URL lands in an issue. */
function scrubEvidence(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? path;
}

export interface RenderBodyOptions {
  /** The live product URL the run targeted (shown in the body). */
  target?: string;
  /** The synthetic workspace slug — surfaced so a reader knows this is NOT a real-tenant issue. */
  workspaceSlug?: string;
}

/** The full issue body for a freshly-found bug — owner-quality, with the dedup marker. */
export function renderFindingBody(f: QaFinding, opts: RenderBodyOptions = {}): string {
  const lines: string[] = [
    "> Auto-filed by the Self-QA Loop (#171). A synthetic user found this on the live product.",
    "",
    selfqaMarker(f.signature),
    "",
    "## Summary",
    `- **Surface:** \`${f.surface}\``,
    `- **Severity:** \`${f.severity}\``,
    `- **Check:** \`${f.checkId}\``,
    `- **Signature:** \`${f.signature}\``,
  ];
  if (opts.target) lines.push(`- **Target:** ${opts.target}`);
  lines.push(
    `- **Source:** synthetic QA workspace \`${opts.workspaceSlug ?? "selfqa-system"}\` ` +
      "(tenant-isolated — never a real customer's data).",
    "",
    "## Repro",
    ...f.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## Expected vs actual",
    `- **Expected:** ${f.expected}`,
    `- **Actual:** ${normalizeActual(f.actual)}`,
  );
  if (f.evidencePath) lines.push(`- **Evidence:** \`${scrubEvidence(f.evidencePath)}\``);
  lines.push(
    "",
    "## Acceptance criteria",
    "- [ ] Root cause identified (not just the visible symptom).",
    `- [ ] The \`${f.checkId}\` self-QA check passes against the live product after the fix.`,
    "- [ ] A regression test covers it so the synthetic user does not have to re-file.",
  );
  return lines.join("\n");
}

/** A comment posted when an already-open finding is seen again — never a duplicate issue (#108 pattern). */
export function renderRecurrenceComment(f: QaFinding, occurrence: number): string {
  return (
    `🔁 Still failing — the \`${f.checkId}\` check (\`${f.surface}\`) tripped again ` +
    `(occurrence #${occurrence}). Signature \`${f.signature}\`. Latest: ${normalizeActual(f.actual)}`
  );
}

/**
 * Map a finding to a #117 flywheel {@link FailureEvent} (the `qa_failure` class). The `message` is
 * stable (no volatile tokens) so the flywheel's own signature is stable too; the normalized detail goes
 * in `detail`. This is the bridge that lets QA findings flow through the existing deduped-failure ledger.
 */
export function toFailureEvent(f: QaFinding, workspaceId: string): FailureEvent {
  return {
    workspaceId,
    failureClass: "qa_failure",
    source: "selfqa",
    message: `[self-qa:${f.surface}] ${f.checkId} failed`,
    detail: `${f.title}\nexpected: ${f.expected}\nactual: ${normalizeActual(f.actual)}`,
  };
}

/** The per-run rollup for the `selfqa_runs` row + the CLI summary line. */
export function summarize(
  suite: QaSuite,
  target: string,
  results: RawCheckResult[],
  findings: QaFinding[],
): QaRunSummary {
  return {
    suite,
    target,
    checksTotal: results.length,
    checksFailed: findings.length,
    criticalCount: findings.filter((f) => f.severity === "critical").length,
  };
}
