import type { FailureEvent } from "../flywheel/types.js";
import type { HealthSignal, RemediationAction } from "./types.js";

/**
 * Self-filing ops postmortems (#193 AC4) — the #171 self-QA two-reporter pattern pointed at ops. When
 * auto-remediation cannot close an incident (it escalates), the incident becomes an owner-quality issue
 * with a timeline, a root cause, and **the check that would have caught it** — and a `ops_incident` row
 * in the #117 flywheel ledger so it flows into the #172 self-shipping loop and dedupes on recurrence.
 *
 * Two reporters share one pure signature so both paths agree on "the same incident":
 *  - {@link githubPostmortemReporter} — stateless CI/in-process path, deduped by a `<!-- self-healing:
 *    <signature> -->` body marker (the #108 uptime pattern): opens once, comments on recurrence.
 *  - {@link flywheelPostmortemReporter} — records the incident as an `ops_incident` FailureEvent.
 */

export interface PostmortemTimelineEntry {
  at: string;
  event: string;
}

/** A finished incident ready to become an issue + a flywheel row. */
export interface OpsPostmortem {
  /** Dedup key: `${workspaceId}|${surfaceKey}|${signal}` — stable across recurrences. */
  signature: string;
  workspaceId: string;
  surfaceKey: string;
  ventureLabel: string;
  signal: HealthSignal;
  /** The remediation that was attempted before escalation (for the timeline + root cause). */
  action: RemediationAction;
  observed: number;
  threshold: number;
  timeline: PostmortemTimelineEntry[];
  /** Why it broke (best-effort, from the correlation + the breached signal). */
  rootCause: string;
  /** The check that would have caught it earlier — the #171 "missing check" field. */
  missingCheck: string;
}

const MARKER_PREFIX = "self-healing:";

export function marker(signature: string): string {
  return `<!-- ${MARKER_PREFIX}${signature} -->`;
}

export function parseMarker(body: string): string | null {
  const m = body.match(/<!--\s*self-healing:([^\s]+)\s*-->/);
  return m ? (m[1] ?? null) : null;
}

export function renderPostmortemTitle(pm: OpsPostmortem): string {
  return `[ops] ${pm.ventureLabel}: ${pm.signal} incident needs a human`;
}

export function renderPostmortemBody(pm: OpsPostmortem): string {
  const lines: string[] = [];
  lines.push(marker(pm.signature));
  lines.push("");
  lines.push(
    `Auto-remediation could not close a \`${pm.signal}\` incident on **${pm.ventureLabel}** ` +
      `(\`${pm.surfaceKey}\`). Attempted action: \`${pm.action}\`.`,
  );
  lines.push("");
  lines.push(`**Observed:** ${pm.observed}  •  **Threshold:** ${pm.threshold}`);
  lines.push("");
  lines.push("## Timeline");
  for (const t of pm.timeline) lines.push(`- \`${t.at}\` — ${t.event}`);
  lines.push("");
  lines.push("## Root cause");
  lines.push(pm.rootCause);
  lines.push("");
  lines.push("## The check that would have caught it");
  lines.push(pm.missingCheck);
  lines.push("");
  lines.push("_Filed automatically by Self-Healing Ops (#193). Feeds the #172 self-shipping loop._");
  return lines.join("\n");
}

export function renderRecurrenceComment(pm: OpsPostmortem): string {
  return (
    `↩️ This ops incident recurred (\`${pm.signal}\` on ${pm.ventureLabel}). ` +
    `Observed ${pm.observed} vs threshold ${pm.threshold}. Auto-remediation (\`${pm.action}\`) escalated again.`
  );
}

/** Map a postmortem to the #117 flywheel `ops_incident` failure event. */
export function toFailureEvent(pm: OpsPostmortem): FailureEvent {
  return {
    workspaceId: pm.workspaceId,
    failureClass: "ops_incident",
    message: `${pm.signal} incident on ${pm.ventureLabel} (${pm.action} escalated)`,
    source: `self-healing:${pm.surfaceKey}`,
    detail: pm.rootCause,
  };
}

// ---- reporters ---------------------------------------------------------------------------------

export type ReportAction = "opened" | "commented" | "recorded" | "noop";

export interface PostmortemReporter {
  report(pm: OpsPostmortem): Promise<{ action: ReportAction }>;
}

/** The minimal issue surface the reporter needs — the #57 GitHubIssueProvider adapts to this. */
export interface IssueClient {
  createIssue(input: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; ref: string }>;
  comment(ref: string, body: string): Promise<void>;
}

export interface GithubPostmortemReporterDeps {
  client: IssueClient;
  /** signature → existing-open-issue ref, pre-read once from open `self-healing`-labelled issues. */
  existingByMarker: Map<string, string>;
  /** Extra labels beyond the defaults (e.g. the env). */
  labels?: string[];
}

/**
 * Open-once / comment-on-recurrence reporter. The caller pre-reads the open `self-healing`-labelled
 * issues and maps each body marker to its ref; a signature already in that map gets a comment (never a
 * duplicate issue). Caches in-run so a second escalation of the same incident comments, not re-opens.
 */
export function githubPostmortemReporter(deps: GithubPostmortemReporterDeps): PostmortemReporter {
  const labels = ["self-healing", "ops", "agent-ok", ...(deps.labels ?? [])];
  return {
    report: async (pm) => {
      const existing = deps.existingByMarker.get(pm.signature);
      if (existing) {
        await deps.client.comment(existing, renderRecurrenceComment(pm));
        return { action: "commented" };
      }
      const { ref } = await deps.client.createIssue({
        title: renderPostmortemTitle(pm),
        body: renderPostmortemBody(pm),
        labels,
      });
      deps.existingByMarker.set(pm.signature, ref);
      return { action: "opened" };
    },
  };
}

export interface FlywheelPostmortemReporterDeps {
  record(event: FailureEvent): Promise<unknown>;
}

/** Records each escalated incident as an `ops_incident` (deduped by the flywheel's own ledger). */
export function flywheelPostmortemReporter(deps: FlywheelPostmortemReporterDeps): PostmortemReporter {
  return {
    report: async (pm) => {
      await deps.record(toFailureEvent(pm));
      return { action: "recorded" };
    },
  };
}

/**
 * File a postmortem through every reporter, fail-soft: one reporter throwing (a flaky GitHub write)
 * must never stop the others (the flywheel record) — the same contract as the #171 `reportFindings`.
 */
export async function filePostmortem(
  pm: OpsPostmortem,
  reporters: PostmortemReporter[],
): Promise<{ reported: number; errored: number }> {
  let reported = 0;
  let errored = 0;
  for (const reporter of reporters) {
    try {
      await reporter.report(pm);
      reported += 1;
    } catch {
      errored += 1;
    }
  }
  return { reported, errored };
}
