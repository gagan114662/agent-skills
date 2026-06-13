import type { HealthSignal, RemediationAction } from "./types.js";

/**
 * Compose the remediation runbook handed to a dispatched fix session (#193 AC2: "with the runbook in
 * context"). Pure + unit-tested. The agent receives the breach, the chosen action, the concrete steps,
 * and — critically — the reversibility rule: destructive steps must go through the #13 approval queue,
 * never run unilaterally (#200 §4). The bundle is DATA the agent reads, never argv.
 */

export interface RunbookContext {
  ventureLabel: string;
  surfaceKey: string;
  signal: HealthSignal;
  action: RemediationAction;
  observed: number;
  threshold: number;
  /** A recent deploy correlated to the incident (the rollback target), or null. */
  correlatedDeployId: string | null;
  /** Whether the chosen action still needs a #13 approval before it may run. */
  requiresApproval: boolean;
}

const SIGNAL_BLURB: Record<HealthSignal, string> = {
  uptime: "the live deployment failed its health probe (it is unreachable)",
  error_rate: "the live deployment's error ratio exceeded its threshold",
  queue_depth: "the work queue/backlog exceeded its threshold",
  stuck_agent: "one or more agent sessions are stuck (no progress within their wall-clock/idle caps)",
};

const ACTION_STEPS: Record<RemediationAction, string[]> = {
  restart: [
    "Re-probe the deployment health endpoint to confirm the outage is real (not a transient blip).",
    "Restart the running process/instance (the reversible action — it has no lasting effect).",
    "Re-probe; if healthy, post the recovery and stop. If still down, do NOT escalate blindly — gather logs first.",
  ],
  rollback: [
    "Confirm the correlated deploy is the most recent `ready` deployment and a prior good one exists.",
    "Re-promote the last green deployment (rollback). This is DESTRUCTIVE — it changes what is live.",
    "Re-probe the rolled-back URL; confirm health before declaring the incident remediated.",
  ],
  scale_up: [
    "Confirm the backlog is sustained, not a one-off spike.",
    "Scale instances UP within the tenant's configured cap (never beyond — bounded blast radius).",
    "Watch the queue drain; if it does not, escalate (the bottleneck is not capacity).",
  ],
  escalate: [
    "No bounded auto-remediation is available or permitted — summarize the incident for the owner.",
    "Attach the timeline, observed vs threshold, and any correlated deploy so the human can act fast.",
  ],
  none: ["Take no action."],
};

export function composeRunbook(ctx: RunbookContext): string {
  const lines: string[] = [];
  lines.push(`# Self-healing remediation: ${ctx.ventureLabel}`);
  lines.push("");
  lines.push(`**Venture:** \`${ctx.surfaceKey}\``);
  lines.push(`**Signal:** \`${ctx.signal}\` — ${SIGNAL_BLURB[ctx.signal]}.`);
  lines.push(`**Observed:** ${ctx.observed}  •  **Threshold:** ${ctx.threshold}`);
  if (ctx.correlatedDeployId) {
    lines.push(`**Correlated deploy:** \`${ctx.correlatedDeployId}\` (likely cause — rollback target).`);
  }
  lines.push(`**Planned action:** \`${ctx.action}\``);
  lines.push("");
  lines.push("## Runbook");
  ACTION_STEPS[ctx.action].forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push("");
  if (ctx.requiresApproval) {
    lines.push(
      "> ⛔ This action is DESTRUCTIVE and is gated. It must be enqueued to the #13 approval queue and " +
        "only run once a human approves — do NOT execute it unilaterally.",
    );
  } else {
    lines.push(
      "> ✅ This action is reversible/pre-committed and bounded. Run it, verify with a fresh probe, then " +
        "report. If it does not restore health, escalate rather than retrying destructively.",
    );
  }
  return lines.join("\n");
}
