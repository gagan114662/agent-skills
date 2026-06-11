/**
 * Uptime monitor — the pure core (#108, ADR-0108). An external heartbeat for the two public URLs
 * (`api.ipop.ai`, `ipop.ai`): a scheduled GitHub Action probes them and, on failure, **opens a GitHub
 * issue** (and comments + closes it on recovery). The judgment lives here, fully unit-tested with no
 * network and no GitHub API — `check-cli.ts` only gathers inputs (fetch the URLs) and applies effects
 * (create/comment/close via the existing #57/#117 `GitHubIssueProvider`).
 *
 * Why pure: same pattern as #17 `decideWorkflowAction`, #96 `decideVenture`, #105 `decideRevival`,
 * #113 `infraBudgetStatus`. The dedupe state is NOT a database row — it is the open issue itself
 * (which is why #108 ships no migration): one outage → one issue → closed on recovery.
 */

/** A URL to watch + what "healthy" means for it. */
export interface ProbeTarget {
  /** Stable id used as the dedupe marker (`api`, `web`). Never change it for a live target. */
  id: string;
  /** Human label for titles/messages, e.g. `api.ipop.ai`. */
  name: string;
  url: string;
  /** HTTP statuses considered healthy (e.g. `[200]`). */
  expectStatus: number[];
  /** Optional substring that must appear in the body (e.g. `ready` for `/readyz`). */
  expectBody?: string;
}

/** The raw result of a single HTTP probe. `status: null` = network error / timeout. */
export interface ProbeResult {
  status: number | null;
  /** A short, length-capped snippet of the response body (for the issue) — never a full page. */
  bodySnippet: string;
  /** Network / timeout error message when `status` is null. */
  error?: string;
  durationMs?: number;
}

/** The verdict for one target: healthy or not, with a human-readable reason. */
export interface HealthVerdict {
  ok: boolean;
  detail: string;
}

/** An already-open `uptime-alert` issue, reduced to what the dedupe brain needs. */
export interface OpenAlertIssue {
  number: number;
  /** The target id parsed from the issue body marker. */
  marker: string;
}

/** What to do about a target this tick. The IO layer just executes it. */
export type AlertAction =
  | { action: "open"; title: string; body: string; labels: string[] }
  | { action: "recover"; issueNumber: number; comment: string }
  | { action: "noop"; reason: string };

/** The label every uptime alert carries — the query the monitor uses to find its own issues. */
export const UPTIME_LABEL = "uptime-alert";

/** Where an operator goes when an alert fires. */
const RUNBOOK = "platform/docs/operations.md (Observability) · platform/docs/playbooks/restore-runbook.md";

/** The hidden, stable dedupe marker embedded in an alert issue's body. */
export function markerFor(id: string): string {
  return `<!-- uptime-monitor:${id} -->`;
}

const MARKER_RE = /<!--\s*uptime-monitor:([A-Za-z0-9._-]+)\s*-->/;

/** Extract a target id from an issue body marker; null when absent. */
export function parseMarker(body: string): string | null {
  return MARKER_RE.exec(body)?.[1] ?? null;
}

/**
 * The health verdict (pure). Healthy ⇔ the status is in `expectStatus` AND (when declared) the body
 * contains `expectBody`. A null status (network error / timeout) is always down and surfaces the error.
 */
export function evaluateResponse(probe: ProbeResult, target: ProbeTarget): HealthVerdict {
  if (probe.status === null) {
    return { ok: false, detail: `no response — ${probe.error ?? "request failed"}` };
  }
  if (!target.expectStatus.includes(probe.status)) {
    return {
      ok: false,
      detail: `HTTP ${probe.status} (expected ${target.expectStatus.join("/")})`,
    };
  }
  if (target.expectBody && !probe.bodySnippet.includes(target.expectBody)) {
    return {
      ok: false,
      detail: `HTTP ${probe.status} but body missing "${target.expectBody}"`,
    };
  }
  return { ok: true, detail: `HTTP ${probe.status}` };
}

/** Title for a target's alert issue — names the target and reads as DOWN. */
export function alertIssueTitle(target: ProbeTarget): string {
  return `[uptime] ${target.name} is DOWN`;
}

/** Body for a target's alert issue — carries the dedupe marker, the URL, the failing detail, runbook. */
export function alertIssueBody(target: ProbeTarget, probe: ProbeResult, verdict: HealthVerdict): string {
  return [
    markerFor(target.id),
    `**${target.name}** failed its uptime check.`,
    "",
    `- **URL:** ${target.url}`,
    `- **Detail:** ${verdict.detail}`,
    probe.bodySnippet ? `- **Response:** \`${probe.bodySnippet}\`` : "- **Response:** (none)",
    "",
    `Opened automatically by the \`uptime-check\` workflow (#108). It will comment and close this issue`,
    `when the target recovers. If it does not recover, follow the runbook: ${RUNBOOK}.`,
  ].join("\n");
}

/** The comment left when a target recovers (just before the issue is closed). */
export function recoveryComment(probe: ProbeResult): string {
  const status = probe.status === null ? "responding" : `HTTP ${probe.status}`;
  return `✅ Recovered — the target is back (${status}). Closing this uptime alert automatically.`;
}

/**
 * The dedupe brain (pure). One issue per outage, never spam, auto-recover:
 *   down + no open issue  → open (once)
 *   down + open issue     → noop (already alerted)
 *   up   + open issue     → recover (comment + close)
 *   up   + no open issue  → noop (steady state)
 */
export function decideAlertAction(
  target: ProbeTarget,
  verdict: HealthVerdict,
  probe: ProbeResult,
  openIssue: OpenAlertIssue | null,
): AlertAction {
  if (!verdict.ok) {
    if (openIssue) return { action: "noop", reason: `already alerting (issue #${openIssue.number})` };
    return {
      action: "open",
      title: alertIssueTitle(target),
      body: alertIssueBody(target, probe, verdict),
      labels: [UPTIME_LABEL],
    };
  }
  if (openIssue) {
    return { action: "recover", issueNumber: openIssue.number, comment: recoveryComment(probe) };
  }
  return { action: "noop", reason: "healthy" };
}

/** The default watch list when `UPTIME_TARGETS` is unset — the two public ipop surfaces. */
export const DEFAULT_TARGETS: ProbeTarget[] = [
  {
    id: "api",
    name: "api.ipop.ai",
    url: "https://api.ipop.ai/readyz",
    expectStatus: [200],
    expectBody: "ready",
  },
  { id: "web", name: "ipop.ai", url: "https://ipop.ai/", expectStatus: [200] },
];

/**
 * Resolve the watch list (pure). Empty/unset → {@link DEFAULT_TARGETS}; otherwise a JSON array of
 * {@link ProbeTarget}. Malformed JSON throws loudly rather than silently watching nothing.
 */
export function parseTargets(raw: string | undefined): ProbeTarget[] {
  if (!raw || !raw.trim()) return DEFAULT_TARGETS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("UPTIME_TARGETS is not valid JSON (expected an array of probe targets)");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("UPTIME_TARGETS must be a non-empty JSON array of probe targets");
  }
  return parsed.map((t, i) => {
    const o = t as Partial<ProbeTarget>;
    if (!o.id || !o.name || !o.url || !Array.isArray(o.expectStatus) || o.expectStatus.length === 0) {
      throw new Error(`UPTIME_TARGETS[${i}] needs id, name, url, and a non-empty expectStatus[]`);
    }
    return {
      id: o.id,
      name: o.name,
      url: o.url,
      expectStatus: o.expectStatus,
      ...(o.expectBody ? { expectBody: o.expectBody } : {}),
    };
  });
}
