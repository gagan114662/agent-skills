import type { SelfHealingCaps, SelfHealingThresholds } from "./caps.js";
import type {
  HealthBreach,
  HealthSignal,
  HealthVerdict,
  RemediationAction,
  ReversibilityClass,
  VentureHealth,
} from "./types.js";

/**
 * The two pure decisions for Self-Healing Ops (#193, ADR-0174). **Pure + unit-tested**: the engine does
 * the side effects (probe, open the incident, dispatch the fix session, enqueue the #13 approval, file
 * the postmortem); these functions just decide. Same split as #112 `decideAlert` / #105 `decideRevival`.
 */

// ---- decideHealth: per-venture monitoring (#193 AC1) ------------------------------------------

/**
 * Map one production-grounded venture probe to the set of breached signals. A signal whose observation
 * is `null` (no probe / unknown) is never a breach — we only ever act on a real reading (#200 §3). The
 * `uptime` breach is a *probe that ran and failed*, not an absent probe.
 */
export function decideHealth(
  health: VentureHealth,
  thresholds: SelfHealingThresholds,
): HealthVerdict {
  const breaches: HealthBreach[] = [];

  if (health.reachable === false) {
    breaches.push({ signal: "uptime", observed: 0, threshold: 1 });
  }
  if (health.errorRate !== null && health.errorRate > thresholds.errorRate) {
    breaches.push({
      signal: "error_rate",
      observed: health.errorRate,
      threshold: thresholds.errorRate,
    });
  }
  if (health.queueDepth !== null && health.queueDepth > thresholds.queueDepth) {
    breaches.push({
      signal: "queue_depth",
      observed: health.queueDepth,
      threshold: thresholds.queueDepth,
    });
  }
  if (health.stuckAgents > 0) {
    breaches.push({ signal: "stuck_agent", observed: health.stuckAgents, threshold: 0 });
  }

  return { healthy: breaches.length === 0, breaches };
}

// ---- decideRemediation: bounded auto-remediation (#193 AC2) -----------------------------------

export interface RemediationInput {
  /** The breached signal we are remediating. */
  signal: HealthSignal;
  /** Workspace kill switch (#17) — authoritative; halts immediately. */
  killSwitch: boolean;
  /** Prior auto-remediation attempts already made on the open incident for this signal. */
  attempts: number;
  /** A recent deploy correlated to this incident (the rollback target), or null when none. */
  correlatedDeployId: string | null;
  caps: SelfHealingCaps;
}

export interface RemediationDecision {
  action: RemediationAction;
  reversibility: ReversibilityClass;
  /** Whether the action must clear a #13 human approval before it runs. */
  requiresApproval: boolean;
  /** Why — surfaced in logs/metrics/the ledger and asserted in tests. */
  reason: string;
}

/** A no-op-shaped escalation: hand the incident to a human via the #13 queue. */
function escalate(reason: string): RemediationDecision {
  return { action: "escalate", reversibility: "reversible", requiresApproval: true, reason };
}

/**
 * Choose the single bounded remediation action for one breached signal. **Fail-closed**: anything we
 * are not explicitly allowed (or able) to auto-fix escalates to a human rather than guessing.
 *
 * Priority is deliberate and answers the #200 premortem:
 *   1. kill switch                         → none   (authoritative halt)
 *   2. auto-remediation disabled           → escalate (monitoring still runs; nothing acts)
 *   3. auto attempts exhausted             → escalate (retried once, now a human — AC3)
 *   4. stuck_agent                         → escalate (the #105 watchdog owns kill+retry; we surface it)
 *   5. queue_depth + scale allowed         → scale_up   (cheap; #13-gated unless pre-committed)
 *   6. uptime/error + deploy + rollback ok → rollback    (cheap; #13-gated unless pre-committed)
 *   7. uptime/error + restart allowed      → restart     (reversible; auto-runs)
 *   8. otherwise                           → escalate (no allowed action)
 *
 * Restart is the only action that auto-runs unconditionally — it is reversible (no lasting effect).
 * Rollback and scale are destructive (they change what's live / spend money), so they stay
 * approval-gated by `requireApprovalForDestructive` unless the owner pre-committed the bounded action.
 */
export function decideRemediation(input: RemediationInput): RemediationDecision {
  const { signal, killSwitch, attempts, correlatedDeployId, caps } = input;

  if (killSwitch) {
    return { action: "none", reversibility: "reversible", requiresApproval: false, reason: "kill_switch" };
  }
  if (!caps.autoRemediate) return escalate("auto_remediation_disabled");
  if (attempts >= caps.maxAutoAttempts) return escalate("retry_exhausted");

  // The watchdog (#105) already kills + retries a stuck agent; self-healing only surfaces + escalates.
  if (signal === "stuck_agent") return escalate("stuck_agent_escalated");

  if (signal === "queue_depth") {
    if (!caps.allowScale) return escalate("scale_not_allowed");
    return {
      action: "scale_up",
      reversibility: "cheap",
      requiresApproval: caps.requireApprovalForDestructive && !caps.preCommitScale,
      reason: "queue_depth_scale",
    };
  }

  // uptime / error_rate: a bad deploy is the likeliest cause, so prefer rollback when we can pin one.
  if (correlatedDeployId && caps.allowRollback) {
    return {
      action: "rollback",
      reversibility: "cheap",
      requiresApproval: caps.requireApprovalForDestructive && !caps.preCommitRollback,
      reason: "rollback_recent_deploy",
    };
  }
  if (caps.allowRestart) {
    return { action: "restart", reversibility: "reversible", requiresApproval: false, reason: "restart" };
  }
  return escalate("no_action_allowed");
}
