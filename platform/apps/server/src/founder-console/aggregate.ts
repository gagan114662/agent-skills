import { budgetExceeded } from "../scale/usage.js";
import {
  forecastUsage,
  recommendRightSizing,
  infraBudgetStatus,
  type CostForecast,
  type ForecastBasis,
  type InfraBudgetStatus,
  type RightSizing,
  type UsageTrendPoint,
} from "../scale/forecast.js";

/**
 * The Founder Console roll-up (#104, ADR-0050). **Pure**: given the read-structs gathered from every
 * subsystem (fleet, venture pipeline, revenue, budget, the pending #13 queue, the safety switches) and
 * a single clock instant, compose the one console view the owner reads for their daily review — and
 * derive the display logic: pipeline counts, budget over/under + utilization, willingness-to-pay
 * presence, each approval's decision-SLA age, the oldest-first queue ordering, and the single
 * "attention" summary (does the platform need a human right now, and why).
 *
 * No IO and no clock of its own (the instant is passed in), so the whole view is one unit-tested
 * function — the #17/#71/#96 pure-core pattern. The IO orchestrator (`service.ts`) gathers the inputs;
 * `default.ts` wires the real repos. The console is strictly READ — no input here mutates anything.
 */

/** A venture verdict (#96). Mirrors `venture/types.ts` `Verdict` (kept local to keep this pure). */
export type Verdict = "FUND" | "KILL" | "ESCALATE" | "ITERATE";

/** Live fleet activity (from the #71 admission snapshot + tenant-usage). */
export interface FleetSnapshot {
  /** Sessions this tenant currently has in flight. */
  tenantInFlight: number;
  /** Sessions the whole fleet currently has in flight. */
  globalInFlight: number;
  /** Sessions this tenant started in the current window. */
  sessionsThisWindow: number;
}

/** One venture evaluation row (#96) reduced to what the pipeline roll-up needs. */
export interface VentureEvalSnapshot {
  ideaId: string;
  /** `active` (still looping) or `terminal`. */
  status: string;
  /** The verdict a terminal evaluation exited on (null while active). */
  terminalVerdict: Verdict | null;
  /** The most recent adversarially-weighted score, if any pass has run. */
  lastScore: number | null;
}

/** Revenue rollup (#98) — totals + the willingness-to-pay evidence count. */
export interface RevenueSnapshot {
  currency: string;
  totalCents: number;
  paymentCount: number;
  /** Count of willingness-to-pay evidence rows (real money changed hands). */
  evidenceCount: number;
}

/** Current-window budget burn (#71 `tenant_usage` + the resolved cap). */
export interface BudgetSnapshot {
  window: string;
  estimatedCostCents: number;
  /** The resolved budget cap in cents (0 = no cap). */
  budgetCents: number;
  computeSeconds: number;
  sessionsStarted: number;
}

/** One pending #13 approval reduced to what the queue view needs. */
export interface PendingApprovalSnapshot {
  id: string;
  actionType: string;
  summary: string;
  amount: number | null;
  /** When the request was created (epoch ms) — the basis for its time-in-queue age. */
  createdAtMs: number;
}

/** One drafted postmortem the SRE Loop (#112) left behind, surfaced as a read-only link. */
export interface PostmortemLinkView {
  incidentId: string;
  service: string;
  sloKind: string;
  /** The repo-relative path under docs/postmortems/. */
  path: string;
  /** When the incident resolved (epoch ms) — newest first in the console. */
  resolvedAtMs: number;
}

/** The global maintenance flag (#99); `unavailable` when Redis could not be read (fail open). */
export interface MaintenanceSnapshot {
  enabled: boolean;
  since?: string;
  reason?: string;
  unavailable?: boolean;
}

/** One deduped failure fingerprint (#117) reduced to what the console pane needs. */
export interface FlywheelFingerprintSnapshot {
  id: string;
  signature: string;
  failureClass: string;
  status: string;
  occurrenceCount: number;
  issueRef: string | null;
  /** Recurrence-after-fix: barred from auto-dispatch, needs human review (#106). */
  excludedFromAutoDispatch: boolean;
  escalated: boolean;
}

/** One fix dispatch (#117) reduced to what the console queue needs. */
export interface FlywheelDispatchSnapshot {
  id: string;
  fingerprintId: string;
  mode: string;
  status: string;
  reason: string;
}

/** The self-healing flywheel read-structs (#117). */
export interface SelfHealingSnapshot {
  fingerprints: FlywheelFingerprintSnapshot[];
  dispatches: FlywheelDispatchSnapshot[];
}

/** The two safety switches surfaced read-only. */
export interface SwitchSnapshot {
  /** The per-workspace autonomy kill switch (#17). */
  killSwitch: boolean;
  /** The platform-wide maintenance flag (#99). */
  maintenance: MaintenanceSnapshot;
}

/** Everything the pure roll-up needs, gathered by the IO orchestrator. */
export interface FounderConsoleInput {
  workspaceId: string;
  /** The clock instant the console was generated at (epoch ms). */
  nowMs: number;
  fleet: FleetSnapshot;
  ventures: VentureEvalSnapshot[];
  revenue: RevenueSnapshot;
  budget: BudgetSnapshot;
  approvals: PendingApprovalSnapshot[];
  switches: SwitchSnapshot;
  /** Recent SRE postmortems (#112), newest first. Optional ⇒ defaults to none (loop off / unwired). */
  postmortems?: PostmortemLinkView[];
  /** Self-healing flywheel state (#117) — optional so the console works before the flywheel is wired. */
  selfHealing?: SelfHealingSnapshot;
  /** Recent per-window usage trend (#71 `tenant_usage`), oldest→newest, feeding the cost forecast (#113). */
  usageTrend: UsageTrendPoint[];
  /** The window the forecast projects (the next calendar month). */
  forecastWindow: string;
  /** The resolved infra budget ceiling in cents (#113, links #108); 0 = no ceiling. */
  infraBudgetCeilingCents: number;
  /** The tenant's in-flight cap (#71) for the right-sizing utilization; 0 = unlimited. */
  tenantConcurrency: number;
}

// ---- derived view ------------------------------------------------------------------------------

export interface FleetView {
  activeSessions: number;
  sessionsThisWindow: number;
  globalInFlight: number;
}

export interface VenturePipelineView {
  total: number;
  active: number;
  funded: number;
  killed: number;
  /** Borderline calls awaiting human judgment (terminal verdict ESCALATE). */
  escalated: number;
}

export interface RevenueView {
  currency: string;
  totalCents: number;
  paymentCount: number;
  willingnessToPayCount: number;
  hasWillingnessToPay: boolean;
}

export interface BudgetView {
  window: string;
  estimatedCostCents: number;
  budgetCents: number;
  overBudget: boolean;
  /** Spent / cap as a fraction; null when no positive cap is set. */
  utilization: number | null;
}

export interface PendingActionView {
  id: string;
  actionType: string;
  summary: string;
  amount: number | null;
  /** Time in queue, in seconds (the decision SLA). Clamped to ≥ 0. */
  ageSeconds: number;
  createdAtMs: number;
}

/** The self-healing flywheel roll-up (#117): lifecycle counts + the human-review/queue surfaces. */
export interface SelfHealingView {
  totalFingerprints: number;
  open: number;
  issued: number;
  fixing: number;
  fixed: number;
  recurred: number;
  /** Recurred-after-fix fingerprints barred from auto-dispatch — a human must review (#106). */
  escalatedAwaitingReview: number;
  /** Fixes auto-launched by the flywheel (mode auto, in flight). */
  autoDispatched: number;
  /** Fixes queued for human approval (mode queued). */
  queuedForApproval: number;
}

/** Next-window compute-cost projection + right-sizing + infra-ceiling status (#113). */
export interface CostForecastView {
  /** The window being forecast (next calendar month). */
  window: string;
  projectedComputeSeconds: number;
  projectedCostCents: number;
  projectedSessionsStarted: number;
  /** How the projection was derived: no history / single point held / fitted trend. */
  basis: ForecastBasis;
  /** Forecast growth vs the last observed cost; null when there's no nonzero base. */
  momChangePct: number | null;
  /** The utilization-driven scale recommendation. */
  rightSizing: RightSizing;
  /** Whether the projection breaches the configured infra budget ceiling (#108). */
  infraBudget: InfraBudgetStatus;
}

export interface AttentionView {
  /** True when the platform needs a human right now. */
  required: boolean;
  /** Human-readable reasons, in priority order. */
  reasons: string[];
}

export interface FounderConsole {
  workspaceId: string;
  generatedAtMs: number;
  fleet: FleetView;
  venturePipeline: VenturePipelineView;
  revenue: RevenueView;
  budget: BudgetView;
  /** Next-window compute-cost forecast + right-sizing + infra-ceiling status (#113). */
  costForecast: CostForecastView;
  /** The pending #13 queue, oldest-first (longest-waiting = highest priority). */
  pendingApprovals: PendingActionView[];
  switches: SwitchSnapshot;
  /** Recent SRE postmortems (#112), newest first — the durable trace each incident left. */
  postmortems: PostmortemLinkView[];
  /** The self-healing flywheel roll-up (#117). Zero-valued when the flywheel is unwired. */
  selfHealing: SelfHealingView;
  attention: AttentionView;
}

function ageSeconds(nowMs: number, createdAtMs: number): number {
  return Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Compose the console view from the gathered read-structs. Pure + deterministic. */
export function aggregateFounderConsole(input: FounderConsoleInput): FounderConsole {
  const { fleet, ventures, revenue, budget, approvals, switches } = input;

  const venturePipeline: VenturePipelineView = {
    total: ventures.length,
    active: ventures.filter((v) => v.status === "active").length,
    funded: ventures.filter((v) => v.terminalVerdict === "FUND").length,
    killed: ventures.filter((v) => v.terminalVerdict === "KILL").length,
    escalated: ventures.filter((v) => v.terminalVerdict === "ESCALATE").length,
  };

  const overBudget = budgetExceeded(budget.estimatedCostCents, budget.budgetCents);
  const budgetView: BudgetView = {
    window: budget.window,
    estimatedCostCents: budget.estimatedCostCents,
    budgetCents: budget.budgetCents,
    overBudget,
    utilization: budget.budgetCents > 0 ? budget.estimatedCostCents / budget.budgetCents : null,
  };

  const revenueView: RevenueView = {
    currency: revenue.currency,
    totalCents: revenue.totalCents,
    paymentCount: revenue.paymentCount,
    willingnessToPayCount: revenue.evidenceCount,
    hasWillingnessToPay: revenue.evidenceCount > 0,
  };

  // #113 cost forecast: project next window's spend from the tenant_usage trend, recommend a scale call
  // from live utilization, and flag a projected breach of the infra budget ceiling (#108). Read-only —
  // admission (#71) remains the only thing that blocks a launch.
  const forecast: CostForecast = forecastUsage(input.usageTrend, input.forecastWindow);
  const rightSizing = recommendRightSizing({
    tenantInFlight: fleet.tenantInFlight,
    tenantConcurrency: input.tenantConcurrency,
  });
  const infraBudget = infraBudgetStatus(forecast.projectedCostCents, input.infraBudgetCeilingCents);
  const costForecast: CostForecastView = {
    window: forecast.window,
    projectedComputeSeconds: forecast.projectedComputeSeconds,
    projectedCostCents: forecast.projectedCostCents,
    projectedSessionsStarted: forecast.projectedSessionsStarted,
    basis: forecast.basis,
    momChangePct: forecast.momChangePct,
    rightSizing,
    infraBudget,
  };

  // Oldest-first: the longest-waiting item is the one most likely to be the bottleneck.
  const pendingApprovals: PendingActionView[] = approvals
    .map((a) => ({
      id: a.id,
      actionType: a.actionType,
      summary: a.summary,
      amount: a.amount,
      ageSeconds: ageSeconds(input.nowMs, a.createdAtMs),
      createdAtMs: a.createdAtMs,
    }))
    .sort((x, y) => x.createdAtMs - y.createdAtMs);

  // Newest-first: the most recent incident's postmortem is the most relevant to the daily review.
  const postmortems: PostmortemLinkView[] = [...(input.postmortems ?? [])].sort(
    (a, b) => b.resolvedAtMs - a.resolvedAtMs,
  );

  const fingerprints = input.selfHealing?.fingerprints ?? [];
  const dispatches = input.selfHealing?.dispatches ?? [];
  const escalatedAwaitingReview = fingerprints.filter((f) => f.excludedFromAutoDispatch).length;
  const queuedForApproval = dispatches.filter((d) => d.mode === "queued" && d.status === "queued").length;
  const selfHealing: SelfHealingView = {
    totalFingerprints: fingerprints.length,
    open: fingerprints.filter((f) => f.status === "open").length,
    issued: fingerprints.filter((f) => f.status === "issued").length,
    fixing: fingerprints.filter((f) => f.status === "fixing").length,
    fixed: fingerprints.filter((f) => f.status === "fixed").length,
    recurred: fingerprints.filter((f) => f.status === "recurred").length,
    escalatedAwaitingReview,
    autoDispatched: dispatches.filter((d) => d.mode === "auto" && d.status === "dispatched").length,
    queuedForApproval,
  };

  const reasons: string[] = [];
  if (switches.killSwitch) reasons.push("kill switch engaged");
  if (switches.maintenance.enabled) reasons.push("maintenance mode active");
  if (overBudget) reasons.push("over budget");
  if (infraBudget.exceeded) reasons.push("infra budget ceiling projected breach");
  if (pendingApprovals.length > 0) reasons.push(pluralize(pendingApprovals.length, "pending approval"));
  if (escalatedAwaitingReview > 0) {
    reasons.push(`${pluralize(escalatedAwaitingReview, "failure")} recurred after fix (review required)`);
  }
  if (queuedForApproval > 0) reasons.push(pluralize(queuedForApproval, "flywheel fix awaiting approval"));

  return {
    workspaceId: input.workspaceId,
    generatedAtMs: input.nowMs,
    fleet: {
      activeSessions: fleet.tenantInFlight,
      sessionsThisWindow: fleet.sessionsThisWindow,
      globalInFlight: fleet.globalInFlight,
    },
    venturePipeline,
    revenue: revenueView,
    budget: budgetView,
    costForecast,
    pendingApprovals,
    switches,
    postmortems,
    selfHealing,
    attention: { required: reasons.length > 0, reasons },
  };
}
