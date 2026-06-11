import type { BundleContext, IncidentRecord } from "./types.js";

/**
 * Compose the **failure bundle** handed to the triage agent (#112, ADR-0112 §6). Pure: it builds the
 * triage task prompt as a DATA string (never argv — the #50 injection-safety contract; the launcher
 * passes it via `AGENT_TASK`). The bundle gives the on-call agent everything it needs to start
 * diagnosing without a human: the breached SLO with observed/target, the recent deploys (a frequent
 * root cause), trace/log id hints to pull, and the runbook links (incl. the #99 DR restore runbook
 * for data-plane incidents).
 */
export function composeFailureBundle(incident: IncidentRecord, ctx: BundleContext): string {
  const deploys = ctx.recentDeploys.length
    ? ctx.recentDeploys.map((d) => `  - ${d.id} → ${d.target} (${d.status}) at ${d.at}`).join("\n")
    : "  - (none recorded)";
  const hints = ctx.traceHints.length ? ctx.traceHints.map((h) => `  - ${h}`).join("\n") : "  - (none)";
  const runbooks = ctx.runbookLinks.length
    ? ctx.runbookLinks.map((r) => `  - ${r}`).join("\n")
    : "  - (none)";

  return [
    `You are the on-call SRE agent for an automatically-detected incident. Triage it: find the most`,
    `likely root cause and propose remediation. Do NOT apply any state-changing fix — risky`,
    `remediation must go through the human approval queue (#13); your job is diagnosis + a written`,
    `recommendation.`,
    ``,
    `Incident ${incident.id} (severity: ${incident.severity})`,
    `Service: ${incident.service}`,
    `Breached SLO: ${incident.sloKind} — observed ${incident.observedValue}, target ${incident.targetValue}`,
    `Error budget remaining: ${(incident.budgetRemaining * 100).toFixed(1)}%`,
    `Opened at: ${incident.openedAt.toISOString()}`,
    ``,
    `Recent deploys (a frequent cause — check these first):`,
    deploys,
    ``,
    `Trace/log hints to pull:`,
    hints,
    ``,
    `Runbooks:`,
    runbooks,
    ``,
    `Deliverable: a short root-cause hypothesis, the evidence you checked, and a remediation`,
    `recommendation (flag whether it needs a #13 approval). When you finish, the loop drafts the`,
    `postmortem skeleton you will refine.`,
  ].join("\n");
}
