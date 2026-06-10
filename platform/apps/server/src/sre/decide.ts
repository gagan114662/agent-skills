import type { IncidentSeverity, SreDecision } from "./types.js";

/**
 * The SRE on-call decision (#112, ADR-0112 §2). **Pure + unit-tested**: given whether a service+SLO is
 * currently breached, the breach severity, whether an incident is already open, the kill switch, and
 * whether the re-page cooldown has elapsed, decide the **single** action the engine applies this tick.
 * The engine does the side effects (open the incident, launch triage, enqueue the #13 remediation,
 * notify, draft the postmortem on resolve) — exactly the #17 `decideWorkflowAction` / #105
 * `decideRevival` split.
 *
 * Priority is deliberate:
 *   1. kill switch                              → noop  (authoritative; halts immediately)
 *   2. recovered + an incident is open          → resolve
 *   3. recovered + nothing open                 → noop  (healthy)
 *   4. fresh breach, warning                    → open  (incident row + triage + notify)
 *   5. fresh breach, critical                   → escalate (open + a #13 remediation approval)
 *   6. still breaching, an incident is open      → notify (re-page) past the cooldown, else noop
 */
export interface AlertDecisionInput {
  breached: boolean;
  severity: IncidentSeverity;
  hasOpenIncident: boolean;
  /** Workspace kill switch (#17) — authoritative; halts immediately. */
  killSwitch: boolean;
  /** Whether the re-page cooldown has elapsed since the open incident's last notification. */
  cooldownElapsed: boolean;
}

export function decideAlert(input: AlertDecisionInput): SreDecision {
  const { breached, severity, hasOpenIncident, killSwitch, cooldownElapsed } = input;

  if (killSwitch) return { action: "noop", reason: "kill_switch", severity };

  if (!breached) {
    return hasOpenIncident
      ? { action: "resolve", reason: "recovered", severity }
      : { action: "noop", reason: "healthy", severity };
  }

  // It IS breached.
  if (!hasOpenIncident) {
    return severity === "critical"
      ? { action: "escalate", reason: "budget_exhausted", severity }
      : { action: "open", reason: "breached", severity };
  }

  // Already firing — only re-page past the cooldown so a sustained breach doesn't spam.
  return cooldownElapsed
    ? { action: "notify", reason: "re_page", severity }
    : { action: "noop", reason: "already_firing", severity };
}
