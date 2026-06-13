/**
 * Shared types for Self-Healing Ops (#193, ADR-0174). The pure `decide`/`runbook`/`reporter` modules
 * and the IO `engine` agree on these — the same pure-decision-in / side-effects-out split as the #112
 * SRE loop and #105 watchdog `types.ts`.
 *
 * The whole loop answers the #200 premortem: checks are production-grounded (§3 — a real probe of the
 * live deployment), actions are reversibility-classed (§4 — irreversible ⇒ pre-commit or human), and
 * destructive actions never auto-run without a #13 approval unless the owner pre-committed.
 */

/** The venture-surface health signals the loop monitors per venture (#193 AC1). */
export type HealthSignal = "uptime" | "error_rate" | "queue_depth" | "stuck_agent";
export const HEALTH_SIGNALS: readonly HealthSignal[] = [
  "uptime",
  "error_rate",
  "queue_depth",
  "stuck_agent",
];

/**
 * The reversibility class of a remediation action (#200 §4). `reversible` = no lasting effect (restart);
 * `cheap` = bounded blast radius + fast/cheap reversal (rollback to last green, scale within caps);
 * `irreversible` = deliverability/brand/legal/unbounded-money — never auto-run, always pre-commit/human.
 */
export type ReversibilityClass = "reversible" | "cheap" | "irreversible";

/** The single bounded action the loop applies to one breached signal this tick. */
export type RemediationAction = "restart" | "rollback" | "scale_up" | "escalate" | "none";

/** Incident lifecycle: firing → remediating (an auto fix is running) | escalated (a human) → resolved. */
export type RemediationStatus = "firing" | "remediating" | "escalated" | "resolved";
export const REMEDIATION_STATUSES: readonly RemediationStatus[] = [
  "firing",
  "remediating",
  "escalated",
  "resolved",
];

/**
 * A raw per-venture probe — the production-grounded signal (#200 §3: checks must touch reality). The
 * engine reads this off the live deployment + metrics; the pure {@link decideHealth} maps it to breaches.
 */
export interface VentureHealth {
  /** Whether the live deployment URL answered a health probe. false ⇒ uptime breach; null ⇒ no probe. */
  reachable: boolean | null;
  /** Observed 5xx/error ratio over the window (0..1). null ⇒ unknown (treated as not breached). */
  errorRate: number | null;
  /** Observed queue depth / backlog. null ⇒ unknown (treated as not breached). */
  queueDepth: number | null;
  /** Count of agents the watchdog escalated for this venture (>0 ⇒ a stuck_agent breach). */
  stuckAgents: number;
}

/** One breached signal with the observed value vs the threshold that tripped it. */
export interface HealthBreach {
  signal: HealthSignal;
  observed: number;
  threshold: number;
}

/** The pure per-venture health verdict for one tick. */
export interface HealthVerdict {
  healthy: boolean;
  breaches: HealthBreach[];
}

/** A monitored venture surface (resolved from live deployments / the owner workspace). */
export interface VentureSurface {
  /** Stable identifier for the surface — the dedup key segment (a deployment host or workspace id). */
  surfaceKey: string;
  /** A human label for narration / postmortems. */
  label: string;
}

/** A durable remediation incident (one row in `self_healing_remediations`). */
export interface RemediationRecord {
  id: string;
  workspaceId: string;
  surfaceKey: string;
  signal: HealthSignal;
  status: RemediationStatus;
  action: RemediationAction | null;
  reversibility: ReversibilityClass | null;
  requiresApproval: boolean;
  approvalRequestId: string | null;
  remediationSessionId: string | null;
  attempts: number;
  observedValue: number | null;
  thresholdValue: number | null;
  detail: string | null;
  postmortemIssueRef: string | null;
  openedAt: Date;
  lastActionAt: Date;
  resolvedAt: Date | null;
}
