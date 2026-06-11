/**
 * Shared types for the SRE Loop (#112, ADR-0112). The pure `slo`/`guards`/`decide`/`bundle`/
 * `postmortem` modules and the IO `engine` agree on these — mirroring the #17 autonomy and #105
 * watchdog `types.ts` split.
 */

/** The SLO dimensions the loop evaluates per service. */
export type SloKind = "availability" | "latency_p95" | "queue_lag";

/** Incident severity, derived from how much of the error budget a breach has burned. */
export type IncidentSeverity = "warning" | "critical";

/** Incident lifecycle. `firing` (open, triaging) → `escalated` (risky remediation queued) → `resolved`. */
export type IncidentStatus = "firing" | "escalated" | "resolved";
export const INCIDENT_STATUSES: readonly IncidentStatus[] = ["firing", "escalated", "resolved"];

/** A single SLO target for one service dimension (declared in config). */
export interface SloTarget {
  kind: SloKind;
  /**
   * The target value, in the dimension's natural unit:
   *  - `availability`: the minimum success ratio (0..1), e.g. 0.999.
   *  - `latency_p95`:  the maximum acceptable p95 latency in milliseconds.
   *  - `queue_lag`:    the maximum acceptable queue lag in seconds.
   */
  target: number;
  /**
   * The fraction of the error budget that, once burned, escalates a breach to `critical`. Default
   * 1.0 (budget fully exhausted ⇒ critical). For latency/queue-lag the "budget" is how far past the
   * target the observation is, normalized — see {@link evaluateSlo}.
   */
  criticalAtBudgetBurn?: number;
}

/** One service's evaluated observation for a single SLO dimension. */
export interface SloObservation {
  kind: SloKind;
  /** The observed value in the same unit as {@link SloTarget.target}. */
  value: number;
  /** How many samples backed the observation (0 ⇒ no signal, treated as not-breached). */
  sampleCount: number;
}

/** The pure SLO judgment for one observation against its target. */
export interface SloEvaluation {
  kind: SloKind;
  breached: boolean;
  /** Remaining error budget as a fraction 0..1 (1 = full budget, 0 = exhausted). */
  budgetRemaining: number;
  severity: IncidentSeverity;
  /** The observed value, echoed for the incident row + bundle. */
  value: number;
  target: number;
}

/** The single action the loop applies to one service+SLO this tick. */
export type SreAction = "open" | "resolve" | "notify" | "escalate" | "noop";

export interface SreDecision {
  action: SreAction;
  /** Why — surfaced in logs/metrics and asserted in tests. */
  reason: string;
  severity: IncidentSeverity;
}

/**
 * A raw per-service signal read off `/metrics` + health probes. The pure `observeService` maps it to
 * an {@link SloObservation} per declared SLO kind; the engine never reasons about raw counters.
 */
export interface ServiceSignal {
  service: string;
  /** Total requests in the window (availability denominator). 0 ⇒ no traffic. */
  windowRequests: number;
  /** Failed requests in the window (5xx / error). */
  windowErrors: number;
  /** Observed p95 latency in milliseconds (0 ⇒ unknown). */
  p95LatencyMs: number;
  /** Observed queue lag in seconds (0 ⇒ none). */
  queueLagSeconds: number;
  /** Health-probe verdict for the dependency (false ⇒ down — forces an availability breach). */
  healthy: boolean;
}

/** A durable incident (one row in `sre_incidents`). */
export interface IncidentRecord {
  id: string;
  workspaceId: string;
  service: string;
  sloKind: SloKind;
  severity: IncidentSeverity;
  status: IncidentStatus;
  observedValue: number;
  targetValue: number;
  budgetRemaining: number;
  /** The triage session launched for this incident (soft ref, null until launched). */
  triageSessionId: string | null;
  /** The drafted postmortem path under docs/postmortems/ (null until resolved + drafted). */
  postmortemPath: string | null;
  openedAt: Date;
  /** Last time a page/notification fired for this incident (the re-page cooldown reference). */
  lastNotifiedAt: Date;
  resolvedAt: Date | null;
}

/** Context the failure bundle weaves in (recent deploys, runbook links, trace hints). */
export interface BundleContext {
  /** Recent deploy descriptors (most recent first) — from the #73 deployments repo. */
  recentDeploys: Array<{ id: string; target: string; status: string; at: string }>;
  /** Recent trace/log id hints to seed the triage agent's investigation. */
  traceHints: string[];
  /** Runbook links (e.g. the #99 DR restore runbook for data-plane incidents). */
  runbookLinks: string[];
}
