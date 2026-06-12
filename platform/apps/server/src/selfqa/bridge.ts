import type { FailureEvent } from "../flywheel/types.js";
import {
  findingLabels,
  renderFindingBody,
  renderFindingTitle,
  renderRecurrenceComment,
  toFailureEvent,
  type RenderBodyOptions,
} from "./render.js";
import type { QaFinding } from "./types.js";

/**
 * The reporter seam for the Self-QA Loop (#171, ADR-0171) — how a structured finding becomes a deduped
 * GitHub issue and/or a #117 flywheel ledger row. Two implementations share the pure-core identity (the
 * fingerprint signature), so both paths agree on what "the same bug" is:
 *
 *  - {@link githubReporter} — the stateless CI path. Dedups via a `<!-- selfqa:<signature> -->` body
 *    marker (the #108 uptime pattern): opens on first sight, comments on recurrence, never spams.
 *  - {@link flywheelReporter} — the in-process path. Records each finding as a `qa_failure` so it flows
 *    through the existing deduped `failure_fingerprints` ledger (and the #104 console / #92 dispatch).
 */

export type ReportAction = "opened" | "commented" | "recorded" | "noop";

export interface FindingReporter {
  report(finding: QaFinding, opts: RenderBodyOptions): Promise<{ action: ReportAction }>;
}

// ---- GitHub (stateless, marker-deduped) -------------------------------------------------------

/** The minimal issue surface the reporter needs — the #57 `GitHubIssueProvider` is adapted to this. */
export interface IssueClient {
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number; ref: string }>;
  comment(ref: string, body: string): Promise<void>;
}

export interface GithubReporterDeps {
  client: IssueClient;
  /** signature → existing-open-issue ref, pre-read once via `listOpenIssuesByLabel` (the dedup index). */
  existingByMarker: Map<string, string>;
}

/**
 * Open-once / comment-on-recurrence reporter. The caller pre-reads the open `selfqa`-labelled issues and
 * maps each one's body marker to its ref; a finding whose signature is already in that map gets a comment
 * (never a duplicate issue), everything else opens a fresh owner-quality issue.
 */
export function githubReporter(deps: GithubReporterDeps): FindingReporter {
  return {
    report: async (finding, opts) => {
      const existing = deps.existingByMarker.get(finding.signature);
      if (existing) {
        await deps.client.comment(existing, renderRecurrenceComment(finding, 2));
        return { action: "commented" };
      }
      const { ref } = await deps.client.createIssue({
        title: renderFindingTitle(finding),
        body: renderFindingBody(finding, opts),
        labels: findingLabels(finding),
      });
      // Remember it so a second finding with the same signature in this same run comments, never re-opens.
      deps.existingByMarker.set(finding.signature, ref);
      return { action: "opened" };
    },
  };
}

// ---- Flywheel (in-process ledger) -------------------------------------------------------------

export interface FlywheelReporterDeps {
  workspaceId: string;
  record(event: FailureEvent): Promise<unknown>;
}

/** Records each finding into the #117 flywheel as a `qa_failure` (deduped by the flywheel's own ledger). */
export function flywheelReporter(deps: FlywheelReporterDeps): FindingReporter {
  return {
    report: async (finding) => {
      await deps.record(toFailureEvent(finding, deps.workspaceId));
      return { action: "recorded" };
    },
  };
}

// ---- orchestration ----------------------------------------------------------------------------

export interface ReportFindingsDeps extends RenderBodyOptions {
  reporter: FindingReporter;
  /** Page the owner for a finding (critical only). Best-effort; an error never aborts the run. */
  pageOwner?: (finding: QaFinding) => Promise<void>;
}

export interface ReportFindingsResult {
  reported: number;
  errored: number;
  paged: number;
}

/**
 * Report every finding through the reporter, paging the owner ONLY for critical severity. A reporter or
 * pager error is counted and logged-by-the-caller, never allowed to abort the rest of the run (one bad
 * GitHub write must not drop the other findings) — the same fail-soft contract as the uptime monitor.
 */
export async function reportFindings(
  findings: QaFinding[],
  deps: ReportFindingsDeps,
): Promise<ReportFindingsResult> {
  const { reporter, pageOwner, ...renderOpts } = deps;
  let reported = 0;
  let errored = 0;
  let paged = 0;
  for (const finding of findings) {
    try {
      await reporter.report(finding, renderOpts);
      reported += 1;
      if (finding.severity === "critical" && pageOwner) {
        try {
          await pageOwner(finding);
          paged += 1;
        } catch {
          // a paging failure must never mask the finding having been filed
        }
      }
    } catch {
      errored += 1;
    }
  }
  return { reported, errored, paged };
}
