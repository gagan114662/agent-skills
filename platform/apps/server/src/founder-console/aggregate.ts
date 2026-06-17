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
import {
  buildProofScorecard,
  type ProofMetricReading,
  type ProofScorecard,
} from "./proof-scorecard.js";

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
  /**
   * Does this venture hold a passing (FUND + funded), unexpired #96 scorecard (#228)? A founding venture
   * funded by owner-activation (#230) reaches terminalVerdict `FUND` *without* one — that is a zero-budget
   * **scaffold**, not a cleared venture. `undefined` = unknown (older callers) → counted as before.
   */
  hasPassingScorecard?: boolean;
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

/** The reliability insights pane (#148): MTTR + frequency + noisiest components off `sre_incidents`. */
export interface ReliabilityInsightsView {
  /** Mean time to resolve (ms) over resolved incidents, or null when none have resolved. */
  mttrMs: number | null;
  incidentsLast7d: number;
  incidentsLast30d: number;
  /** Currently active (non-resolved) incidents. */
  openCount: number;
  total: number;
  /** Services ranked by incident count, descending. */
  noisiestComponents: Array<{ service: string; count: number }>;
}

/** The global maintenance flag (#99); `unavailable` when Redis could not be read (fail open). */
export interface MaintenanceSnapshot {
  enabled: boolean;
  since?: string;
  reason?: string;
  unavailable?: boolean;
}

/**
 * An action class agents currently **own** — auto-approved by the #119 evidence pricer — with the
 * measured error rate that earned the relaxed boundary and when it was relaxed.
 */
export interface GateBoundarySnapshot {
  actionType: string;
  /** The measured correction rate (0–1) that earned the current relaxed boundary. */
  errorRate: number;
  /** Decisions in the window that earned it. */
  windowSize: number;
  /** When the boundary was last relaxed (epoch ms). */
  sinceMs: number;
}

/** One #119 boundary change (RELAX/RETIGHTEN) for the Console history. */
export interface GateBoundaryChangeSnapshot {
  actionType: string;
  direction: "RELAX" | "RETIGHTEN";
  errorRate: number;
  windowSize: number;
  /** When the change was applied (epoch ms). */
  atMs: number;
  reason: string;
}

/** The #119 evidence-priced boundaries: classes agents own + the change history. */
export interface GateBoundariesSnapshot {
  owned: GateBoundarySnapshot[];
  history: GateBoundaryChangeSnapshot[];
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

/**
 * Self-healing OPS roll-up (#193): the per-venture incident counts + the watchdog stuck-agent count.
 * Drives the console fleet-health signal — any escalated incident or stuck agent turns the dot red.
 */
export interface SelfHealingOpsSnapshot {
  /** Incidents firing/remediating (auto-remediation in flight). */
  openIncidents: number;
  /** Incidents escalated to a human (auto-remediation could not close them). */
  escalatedIncidents: number;
  /** Agents the #105 watchdog escalated as stuck (the fleet-health red signal). */
  stuckAgents: number;
}

/** One self-shipping run (#172) reduced to what the console queue / merge-history pane needs. */
export interface BuildLoopRunSnapshot {
  id: string;
  issueRef: string;
  issueTitle: string;
  status: string;
  reviewRounds: number;
  prRef: string | null;
  mergeRef: string | null;
  escalationReason: string | null;
}

/** The self-shipping loop read-struct (#172) — the runs feeding the console pane. */
export interface BuildLoopSnapshot {
  runs: BuildLoopRunSnapshot[];
}

/** One channel experiment (#102/#123) reduced to what the console pane counts. */
export interface GrowthExperimentStatusSnapshot {
  status: string;
  /** True once an `external.send` post has been submitted to the #13 gate for this experiment. */
  hasExternalPost: boolean;
}

/** The Growth Loop read-struct (#102): the funnel + score + experiment lifecycle, already computed. */
export interface GrowthSnapshot {
  /** Total growth events recorded for the workspace. */
  totalEvents: number;
  funnel: { acquisition: number; activation: number; conversion: number; retention: number };
  /** The 0–100 growth score (computed by the reader off the same pure scorer the routes use). */
  score: number;
  /** The top acquisition source by weight, or null when there is no traffic. */
  topSource: string | null;
  experiments: GrowthExperimentStatusSnapshot[];
}

/** One GTM stage in the Customer Discovery pipeline (#222) reduced to what the console pane counts. */
export interface DiscoveryPipelineStageSnapshot {
  stage: string;
  prospects: number;
  /** Of those, the count whose stage entry was externally grounded (a real receipt). */
  verifiedProspects: number;
}

/** The Customer Discovery GTM pipeline read-struct (#222): the 5 stages + the PQL count at the top. */
export interface DiscoveryPipelineSnapshot {
  stages: DiscoveryPipelineStageSnapshot[];
  totalProspects: number;
  /** PQL (product-qualified-lead) events emitted — the top of the pipeline. */
  pqlCount: number;
}

/**
 * The outreach engine roll-up (#225): experiments running + the EXTERNAL receipt counts (replies/meetings/
 * signups) and the gated send queue. Every count is real (external receipts / parked messages) — never a
 * placeholder. Identical shape on input + output so the console + API never disagree.
 */
export interface OutreachSnapshot {
  experimentsRunning: number;
  experimentsConcluded: number;
  messagesPendingApproval: number;
  messagesSent: number;
  replies: number;
  meetings: number;
  signups: number;
}

/** One ranked backlog item (#115) reduced to what the roadmap pane shows. */
export interface PlanningItemSnapshot {
  id: string;
  title: string;
  source: string;
  /** The why-ranked-here evidence link (source_ref). */
  sourceRef: string;
  /** The RICE score that earned the rank (computed by the reader off the same pure scorer the routes use). */
  score: number;
  /** 1-based rank position. */
  position: number;
  status: string;
  isPivot: boolean;
  /** A #13 approval is pending for this item's dispatch. */
  awaitingApproval: boolean;
}

/** The Product Planning Loop read-struct (#115): the ranked backlog + whether the loop is enabled. */
export interface PlanningSnapshot {
  enabled: boolean;
  items: PlanningItemSnapshot[];
}

/** One venture's moat roll-up (#103) reduced to what the console pane needs. Mirrors `moat/types.ts`
 * `VentureMoat` minus the per-dimension breakdown (kept local to keep this module pure). */
export interface MoatVentureSnapshot {
  ventureIdeaId: string;
  /** 0–100 weighted moat score. */
  score: number;
  /** True when zero accrual landed in the stagnation window (the pivot/kill signal). */
  stagnant: boolean;
  accrualsInWindow: number;
  lastAccrualAtMs: number | null;
}

/** One portfolio review (#107) reduced to what the console pane counts — the latest review per venture.
 * Mirrors `portfolio/types.ts` `PortfolioReviewRecord` minus the evidence snapshot (kept local + pure). */
export interface PortfolioReviewSnapshot {
  ventureIdeaId: string;
  /** `DOUBLE_DOWN` | `MAINTAIN` | `PIVOT` | `SUNSET`. */
  decision: string;
  /** `recorded` | `sunset_pending` | `sunset_executed` | `sunset_rejected`. */
  status: string;
  /** 0–100 composite portfolio-health score. */
  score: number;
  /** `revenueCents − monthlyCostCents` (negative = burning). */
  netCents: number;
  /** When the review was recorded (epoch ms) — newest wins when deduping to latest-per-venture. */
  createdAtMs: number;
}

/** The two safety switches surfaced read-only. */
/** The Customer Voice read-struct (#114): the post-launch support/churn roll-up, already computed by the
 * reader off the same pure digest/metrics the routes use (so the console + API never disagree). */
export interface VoiceSnapshot {
  /** Tickets not yet replied/closed — the inbox that still needs a human. */
  ticketsNeedingHuman: number;
  /** NPS over the digest window (−100…100), or null when there are no NPS responses. */
  npsScore: number | null;
  /** High-churn-risk signals in the window. */
  highChurnRisk: number;
  /** Negative-sentiment signals in the window. */
  negativeSentiment: number;
  /** Total voice signals in the window. */
  totalSignals: number;
  /** The drafted digest headline. */
  digestHeadline: string;
}

/** The Support Desk SLA read-struct (#190): first-response SLA breaches + reality-grounded resolution. */
export interface SupportSlaSnapshot {
  /** Tickets past the first-response SLA window still awaiting a reply (the breach count). */
  breaches: number;
  /** Whole minutes the worst breach is overdue (0 when none). */
  worstOverdueMinutes: number;
  /** Tickets resolved per an EXTERNAL receipt — the only trustworthy resolution figure (premortem §2). */
  resolvedVerified: number;
  /** Tickets marked replied/closed with NO external receipt — reported UNVERIFIED, never acted on alone. */
  resolvedUnverified: number;
}

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
  /** Reliability insights (#148) off `sre_incidents`. Optional ⇒ a zeroed pane (loop off / unwired). */
  reliability?: ReliabilityInsightsView;
  /** The #119 evidence-priced autonomy boundaries (owned classes + change history). */
  gateBoundaries: GateBoundariesSnapshot;
  /** Self-healing flywheel state (#117) — optional so the console works before the flywheel is wired. */
  selfHealing?: SelfHealingSnapshot;
  /** Self-healing OPS state (#193) — open per-venture incidents + stuck agents. Optional ⇒ zeroed. */
  selfHealingOps?: SelfHealingOpsSnapshot;
  /** Self-shipping loop state (#172) — optional so the console works before the loop is wired. */
  buildLoop?: BuildLoopSnapshot;
  /** Growth Loop state (#102) — optional so the console works before the growth loop is wired. */
  growth?: GrowthSnapshot;
  /** Customer Discovery GTM pipeline (#222) — optional so the console works before discovery is wired. */
  discoveryPipeline?: DiscoveryPipelineSnapshot;
  /** Outreach engine roll-up (#225) — optional so the console works before outreach is wired. */
  outreach?: OutreachSnapshot;
  /** Recent per-window usage trend (#71 `tenant_usage`), oldest→newest, feeding the cost forecast (#113). */
  usageTrend: UsageTrendPoint[];
  /** The window the forecast projects (the next calendar month). */
  forecastWindow: string;
  /** The resolved infra budget ceiling in cents (#113, links #108); 0 = no ceiling. */
  infraBudgetCeilingCents: number;
  /** The tenant's in-flight cap (#71) for the right-sizing utilization; 0 = unlimited. */
  tenantConcurrency: number;
  /** Product Planning Loop state (#115) — optional so the console works before the planning loop is wired. */
  planning?: PlanningSnapshot;
  /** Per-venture moat roll-ups (#103). Optional ⇒ defaults to none (moat unwired). */
  moat?: MoatVentureSnapshot[];
  /** Whether moat stagnation flagging is enabled (#103 `moat.enabled`). Default false. */
  moatEnabled?: boolean;
  /** The moat stagnation window in days (#103), for the attention message. Default 30. */
  moatWindowDays?: number;
  /** Open constitution violations (#146). Optional ⇒ none (enforcement off / unwired). */
  constitution?: ConstitutionSnapshot;
  /** Customer Voice roll-up (#114) — optional so the console works before the voice loop is wired. */
  voice?: VoiceSnapshot;
  /** Support Desk SLA roll-up (#190) — optional so the console works before the support desk is wired. */
  supportSla?: SupportSlaSnapshot;
  /** Portfolio reviews (#107), newest-first across all ventures. Optional ⇒ zeroed portfolio view. */
  portfolio?: PortfolioReviewSnapshot[];
  /** Whether the portfolio loop is enabled (#107 `portfolio.enabled`), gating its attention. Default false. */
  portfolioEnabled?: boolean;
  /** External account onboarding roll-up (#192). Optional ⇒ zeroed pane (onboarding off / unwired). */
  setup?: SetupSnapshot;
  /**
   * Per-department PROOF readings (#253) — one real, sourced outcome reading per marketing department. Optional
   * ⇒ the scorecard still renders all seven tiles as "not connected" (no source wired). Departments absent from
   * the array also render "not connected"; the builder never fabricates a number.
   */
  proofReadings?: ProofMetricReading[];
}

/** External account onboarding roll-up (#192) — the setup checklist + credential-hygiene pulse. */
export interface SetupSnapshot {
  /** Services still awaiting the owner (filed but not connected, not dismissed). */
  pendingSetup: number;
  /**
   * Connected (operational) connections — INCLUDING the Claude runtime subscription (#68), not just the
   * #192 external-service vault. Fixes the #231 readiness bug where `connected` read 0 with Claude wired.
   */
  connected: number;
  /** Connected credentials currently past their rotation age. */
  rotationDue: number;
  /** Dependent capabilities currently offline because a required credential is missing/revoked. */
  offlineCapabilities: number;
  /**
   * External account kinds the owner must still connect before a venture can do REAL real-world work
   * (#231) — the union of accounts the real-world tools act through (hosting/ESP/registrar/ad) minus
   * what's connected. >0 means the fleet can mutate internal state but cannot publish/send/post yet.
   */
  needed: number;
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
  /** Ventures that have truly cleared the #96 bar (terminal FUND **with** a passing, unexpired scorecard). */
  funded: number;
  killed: number;
  /** Borderline calls awaiting human judgment (terminal verdict ESCALATE). */
  escalated: number;
  /**
   * Zero-budget scaffolds (#228): terminal-FUND ventures that were owner-activated (#230) into a build epic
   * but have NOT earned a passing #96 scorecard. They get zero autonomy budget (the admission gate keeps
   * blocking) until they clear the bar — surfaced separately so the console never shows them as "funded".
   */
  scaffolds: number;
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

/** The #119 boundaries surface: which classes agents own (by earned error rate) + the change log. */
export interface AutonomyBoundariesView {
  owned: GateBoundarySnapshot[];
  history: GateBoundaryChangeSnapshot[];
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

/** The self-shipping loop roll-up (#172): lifecycle counts + the queue / in-flight / merge surfaces. */
export interface BuildLoopView {
  totalRuns: number;
  /** Agent-ok issues waiting for a build seat. */
  queued: number;
  /** Runs with a live build/review/revise session or an in-progress merge. */
  inFlight: number;
  /** Runs auto-merged within guardrails (the merge history). */
  merged: number;
  /** Runs handed to the owner (outside guardrails / max review rounds) — needs a human. */
  escalated: number;
}

/** The Growth Loop roll-up (#102): the funnel score + stage counts + the experiment pipeline. */
export interface GrowthView {
  /** The 0–100 growth score. */
  score: number;
  totalEvents: number;
  acquisition: number;
  activation: number;
  conversion: number;
  retention: number;
  /** The top acquisition source by weight, or null when there is no traffic. */
  topSource: string | null;
  experimentsProposed: number;
  experimentsRunning: number;
  experimentsTotal: number;
  /** Experiments whose external post has been submitted to the #13 gate (a human posts). */
  externalPostsSubmitted: number;
}

/** The Customer Discovery GTM pipeline roll-up (#222): per-stage counts + the PQL count. Zeroed when
 * discovery is unwired. Every count is event-driven off real signals — never a placeholder. */
export interface DiscoveryPipelineView {
  /** PQL (product-qualified-lead) events emitted — the top of the pipeline. */
  pqlCount: number;
  /** Distinct prospects across all stages. */
  totalProspects: number;
  /** The five canonical GTM stages with their distinct-prospect counts (verified + total). */
  stages: DiscoveryPipelineStageSnapshot[];
}

/** The outreach engine roll-up (#225): experiments running + EXTERNAL receipts + the gated send queue.
 * Zeroed when outreach is unwired. Every count is event-driven off real receipts/messages — never a
 * placeholder. */
export interface OutreachView {
  experimentsRunning: number;
  experimentsConcluded: number;
  messagesPendingApproval: number;
  messagesSent: number;
  replies: number;
  meetings: number;
  signups: number;
}

/** One roadmap row (#115): a ranked backlog item with its why-ranked-here evidence link. */
export interface PlanningRoadmapItemView {
  id: string;
  title: string;
  source: string;
  /** The why-ranked-here evidence link (source_ref). */
  evidenceRef: string;
  score: number;
  position: number;
  status: string;
  isPivot: boolean;
  awaitingApproval: boolean;
}

/** The Product Planning Loop roll-up (#115): the ranked roadmap + lifecycle counts. */
export interface PlanningView {
  /** Whether the proactive planning tick is enabled (#115 `planning.enabled`). */
  enabled: boolean;
  total: number;
  proposed: number;
  specced: number;
  dispatched: number;
  /** Items whose dispatch is queued for #13 approval (pivot / over-budget / not #95-allowed). */
  awaitingApproval: number;
  /** The ranked backlog, highest RICE first — the roadmap with why-ranked-here links per item. */
  roadmap: PlanningRoadmapItemView[];
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

/** One flagged-stagnant venture surfaced in the console moat pane (#103). */
export interface MoatVentureView {
  ventureIdeaId: string;
  score: number;
  accrualsInWindow: number;
  lastAccrualAtMs: number | null;
}

/** The moat-accrual roll-up (#103): how many ventures are tracked + which have stopped compounding. */
export interface MoatView {
  /** Whether stagnation flagging is enabled (gates the attention reason). */
  enabled: boolean;
  /** The stagnation window in days. */
  windowDays: number;
  /** Ventures with a moat roll-up this tick. */
  tracked: number;
  /** Tracked ventures with zero accrual in the window. */
  flaggedStagnant: number;
  /** The stagnant ventures (the pivot/kill candidates #107 acts on). */
  flagged: MoatVentureView[];
}

/** Open constitution violations (#146) the owner should review. */
export interface ConstitutionSnapshot {
  openViolations: number;
  /** The distinct violation codes present, for the attention message. */
  topCodes: string[];
}

export interface ConstitutionView {
  openViolations: number;
  topCodes: string[];
}

/** The Customer Voice roll-up (#114): the support inbox + churn/NPS pulse. Zeroed when voice is unwired. */
export interface VoiceView {
  ticketsNeedingHuman: number;
  npsScore: number | null;
  highChurnRisk: number;
  negativeSentiment: number;
  totalSignals: number;
  digestHeadline: string;
}

/** The Support Desk SLA roll-up (#190): first-response breaches + verified-vs-UNVERIFIED resolution. */
export interface SupportSlaView {
  breaches: number;
  worstOverdueMinutes: number;
  resolvedVerified: number;
  resolvedUnverified: number;
}

/** One launched venture's latest portfolio decision (#107), surfaced on the console pane. */
export interface PortfolioVentureView {
  ventureIdeaId: string;
  decision: string;
  status: string;
  score: number;
  netCents: number;
}

/** The portfolio lifecycle roll-up (#107): launched-venture decision counts + the sunset gate queue. */
export interface PortfolioView {
  /** Whether the portfolio loop is enabled (gates the attention reason). */
  enabled: boolean;
  /** Distinct launched ventures with a review (the latest review per venture). */
  reviewed: number;
  doubleDown: number;
  maintain: number;
  pivot: number;
  /** Ventures whose latest decision is SUNSET. */
  sunset: number;
  /** SUNSET reviews recommended but not yet requested (status `recorded`) — the kill backlog. */
  sunsetsRecommended: number;
  /** SUNSET reviews awaiting a human #13 approval (status `sunset_pending`). */
  sunsetsPendingApproval: number;
  /** The launched ventures + their latest decision (the dashboard surface). */
  ventures: PortfolioVentureView[];
}

/** The external account onboarding roll-up (#192): the setup checklist + credential-hygiene pulse. */
export interface SetupView {
  pendingSetup: number;
  connected: number;
  rotationDue: number;
  offlineCapabilities: number;
  /** External account kinds still to connect before a venture can do real work (#231). */
  needed: number;
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
  /** Reliability insights (#148): MTTR, frequency, open count, noisiest components. */
  reliability: ReliabilityInsightsView;
  /** The #119 evidence-priced autonomy boundaries: classes agents own + the change history. */
  autonomyBoundaries: AutonomyBoundariesView;
  /** The self-healing flywheel roll-up (#117). Zero-valued when the flywheel is unwired. */
  selfHealing: SelfHealingView;
  /** The self-healing OPS roll-up (#193): per-venture incidents + stuck agents. Zeroed when unwired. */
  selfHealingOps: SelfHealingOpsSnapshot;
  /** The self-shipping loop roll-up (#172). Zero-valued when the loop is unwired. */
  buildLoop: BuildLoopView;
  /** The Growth Loop roll-up (#102). Zero-valued when the growth loop is unwired. */
  growth: GrowthView;
  /** The Customer Discovery GTM pipeline (#222). Zero-valued when discovery is unwired. */
  discoveryPipeline: DiscoveryPipelineView;
  /** The outreach engine roll-up (#225). Zero-valued when outreach is unwired. */
  outreach: OutreachView;
  /** The Product Planning Loop roadmap (#115). Empty when the planning loop is unwired. */
  planning: PlanningView;
  /** The moat-accrual roll-up (#103). Zero-valued when moat is unwired. */
  moat: MoatView;
  /** Open constitution violations (#146). Zero-valued when enforcement is off / unwired. */
  constitution: ConstitutionView;
  /** The Customer Voice roll-up (#114). Zero-valued when the voice loop is unwired. */
  voice: VoiceView;
  /** The Support Desk SLA roll-up (#190). Zero-valued when the support desk is unwired. */
  supportSla: SupportSlaView;
  /** The portfolio lifecycle roll-up (#107). Zero-valued when the portfolio loop is unwired. */
  portfolio: PortfolioView;
  /** The external account onboarding roll-up (#192). Zero-valued when onboarding is off / unwired. */
  setup: SetupView;
  /**
   * The per-department PROOF scorecard (#253): one tile per marketing department carrying a real, sourced
   * outcome metric + trend — or "not connected" where a source isn't wired yet. Always present (all-seven).
   */
  proofScorecard: ProofScorecard;
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
  const { fleet, ventures, revenue, budget, approvals, switches, gateBoundaries } = input;

  // #228: a terminal-FUND venture is a zero-budget SCAFFOLD until it earns a passing #96 scorecard. Only
  // ventures explicitly known to lack one (`hasPassingScorecard === false`) are split out of `funded` — an
  // `undefined` flag (older callers that don't supply it) keeps the prior behavior (counted as funded).
  const isScaffold = (v: VentureEvalSnapshot): boolean =>
    v.terminalVerdict === "FUND" && v.hasPassingScorecard === false;
  const venturePipeline: VenturePipelineView = {
    total: ventures.length,
    active: ventures.filter((v) => v.status === "active").length,
    funded: ventures.filter((v) => v.terminalVerdict === "FUND" && !isScaffold(v)).length,
    killed: ventures.filter((v) => v.terminalVerdict === "KILL").length,
    escalated: ventures.filter((v) => v.terminalVerdict === "ESCALATE").length,
    scaffolds: ventures.filter(isScaffold).length,
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

  // #148 reliability insights — zeroed when the SRE loop is off/unwired (no incidents reader).
  const reliability: ReliabilityInsightsView = input.reliability ?? {
    mttrMs: null,
    incidentsLast7d: 0,
    incidentsLast30d: 0,
    openCount: 0,
    total: 0,
    noisiestComponents: [],
  };

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

  // #172 self-shipping loop: lifecycle counts off the runs (queue / in-flight / merged / escalated).
  const buildRuns = input.buildLoop?.runs ?? [];
  const inFlightStatuses = new Set(["building", "reviewing", "revising", "merging"]);
  const buildLoopEscalated = buildRuns.filter((r) => r.status === "escalated").length;
  const buildLoop: BuildLoopView = {
    totalRuns: buildRuns.length,
    queued: buildRuns.filter((r) => r.status === "queued").length,
    inFlight: buildRuns.filter((r) => inFlightStatuses.has(r.status)).length,
    merged: buildRuns.filter((r) => r.status === "merged").length,
    escalated: buildLoopEscalated,
  };

  // #102 growth loop: reshape the already-computed funnel + experiment lifecycle into the pane. The
  // score is computed by the reader (off the same pure scorer the routes use), so this stays pure +
  // deterministic — counting only.
  const growthExperiments = input.growth?.experiments ?? [];
  const growth: GrowthView = {
    score: input.growth?.score ?? 0,
    totalEvents: input.growth?.totalEvents ?? 0,
    acquisition: input.growth?.funnel.acquisition ?? 0,
    activation: input.growth?.funnel.activation ?? 0,
    conversion: input.growth?.funnel.conversion ?? 0,
    retention: input.growth?.funnel.retention ?? 0,
    topSource: input.growth?.topSource ?? null,
    experimentsProposed: growthExperiments.filter((e) => e.status === "proposed").length,
    experimentsRunning: growthExperiments.filter((e) => e.status === "running").length,
    experimentsTotal: growthExperiments.length,
    externalPostsSubmitted: growthExperiments.filter((e) => e.hasExternalPost).length,
  };

  // #222 customer discovery engine: the 5-stage GTM pipeline (outreach → discovery → conversion →
  // onboarding → post_sales). Counting only — the per-stage distinct-prospect counts come from the reader
  // off the SAME pure pipelineMetrics the discovery routes use, so the console matches the API. Zeroed
  // (all five stages at 0) when discovery is unwired.
  const discoveryPipeline: DiscoveryPipelineView = {
    pqlCount: input.discoveryPipeline?.pqlCount ?? 0,
    totalProspects: input.discoveryPipeline?.totalProspects ?? 0,
    stages: input.discoveryPipeline?.stages ?? [],
  };

  // #225 outreach engine: experiments running + EXTERNAL receipt counts + the gated send queue. Counting
  // only — every number is a real receipt/message count from the reader (external receipts are the only
  // verified outreach metric, premortem #200 §2). Zeroed when outreach is unwired.
  const outreach: OutreachView = {
    experimentsRunning: input.outreach?.experimentsRunning ?? 0,
    experimentsConcluded: input.outreach?.experimentsConcluded ?? 0,
    messagesPendingApproval: input.outreach?.messagesPendingApproval ?? 0,
    messagesSent: input.outreach?.messagesSent ?? 0,
    replies: input.outreach?.replies ?? 0,
    meetings: input.outreach?.meetings ?? 0,
    signups: input.outreach?.signups ?? 0,
  };

  // #115 product planning loop: reshape the ranked backlog into the roadmap pane — each row carries its
  // why-ranked-here evidence link + RICE score. Counting only (the score is computed by the reader off
  // the same pure scorer the routes use), so this stays pure + deterministic.
  const planningItems = input.planning?.items ?? [];
  const planning: PlanningView = {
    enabled: input.planning?.enabled ?? false,
    total: planningItems.length,
    proposed: planningItems.filter((i) => i.status === "proposed").length,
    specced: planningItems.filter((i) => i.status === "specced").length,
    dispatched: planningItems.filter((i) => i.status === "dispatched").length,
    awaitingApproval: planningItems.filter((i) => i.awaitingApproval).length,
    roadmap: planningItems.map((i) => ({
      id: i.id,
      title: i.title,
      source: i.source,
      evidenceRef: i.sourceRef,
      score: i.score,
      position: i.position,
      status: i.status,
      isPivot: i.isPivot,
      awaitingApproval: i.awaitingApproval,
    })),
  };

  // #103 moat accrual: surface every tracked venture's moat roll-up and flag the ones that have
  // stopped compounding (zero accrual in the window). The count is always reported; the attention
  // reason is gated on `moatEnabled` (mirrors how #119 evidence recording is always-on but the
  // pricer is gated) so a deployment that hasn't opted in is never nagged.
  const moatSnapshots = input.moat ?? [];
  const moatWindowDays = input.moatWindowDays ?? 30;
  const flaggedMoat = moatSnapshots.filter((m) => m.stagnant);
  const moat: MoatView = {
    enabled: input.moatEnabled ?? false,
    windowDays: moatWindowDays,
    tracked: moatSnapshots.length,
    flaggedStagnant: flaggedMoat.length,
    flagged: flaggedMoat.map((m) => ({
      ventureIdeaId: m.ventureIdeaId,
      score: m.score,
      accrualsInWindow: m.accrualsInWindow,
      lastAccrualAtMs: m.lastAccrualAtMs,
    })),
  };

  // #146 constitution: surface the count of open (un-acknowledged) violations. Flag-only — these are
  // heuristics, not physics; the owner reviews and decides. Always reported; zero when unwired/off.
  const constitution: ConstitutionView = {
    openViolations: input.constitution?.openViolations ?? 0,
    topCodes: input.constitution?.topCodes ?? [],
  };

  // #114 customer voice: the post-launch support inbox + churn/NPS pulse. Zeroed when unwired so the
  // console renders before the voice loop is configured. Tickets needing a human are an attention reason
  // (talking to users is the irreducible human work the premortem is about).
  const voice: VoiceView = {
    ticketsNeedingHuman: input.voice?.ticketsNeedingHuman ?? 0,
    npsScore: input.voice?.npsScore ?? null,
    highChurnRisk: input.voice?.highChurnRisk ?? 0,
    negativeSentiment: input.voice?.negativeSentiment ?? 0,
    totalSignals: input.voice?.totalSignals ?? 0,
    digestHeadline: input.voice?.digestHeadline ?? "",
  };

  // #190 support desk: first-response SLA breaches + reality-grounded resolution. Zeroed when the desk is
  // unwired. A breach is an attention reason (a venture must answer its customers); the resolution split
  // surfaces the verified figure next to the UNVERIFIED one so a self-reported "closed" never masquerades
  // as a real resolution (premortem §2).
  const supportSla: SupportSlaView = {
    breaches: input.supportSla?.breaches ?? 0,
    worstOverdueMinutes: input.supportSla?.worstOverdueMinutes ?? 0,
    resolvedVerified: input.supportSla?.resolvedVerified ?? 0,
    resolvedUnverified: input.supportSla?.resolvedUnverified ?? 0,
  };

  // #107 portfolio lifecycle: reduce the reviews to the LATEST per venture (newest-first input), count
  // by decision, and surface the sunset (kill) gate queue. Counts always report; the attention reason is
  // gated on `portfolioEnabled` (mirrors moat) so a deployment that hasn't opted in is never nagged.
  const portfolioReviews = input.portfolio ?? [];
  const latestByVenture = new Map<string, PortfolioReviewSnapshot>();
  for (const r of [...portfolioReviews].sort((a, b) => b.createdAtMs - a.createdAtMs)) {
    if (!latestByVenture.has(r.ventureIdeaId)) latestByVenture.set(r.ventureIdeaId, r);
  }
  const latestReviews = [...latestByVenture.values()];
  const portfolio: PortfolioView = {
    enabled: input.portfolioEnabled ?? false,
    reviewed: latestReviews.length,
    doubleDown: latestReviews.filter((r) => r.decision === "DOUBLE_DOWN").length,
    maintain: latestReviews.filter((r) => r.decision === "MAINTAIN").length,
    pivot: latestReviews.filter((r) => r.decision === "PIVOT").length,
    sunset: latestReviews.filter((r) => r.decision === "SUNSET").length,
    sunsetsRecommended: latestReviews.filter(
      (r) => r.decision === "SUNSET" && r.status === "recorded",
    ).length,
    sunsetsPendingApproval: latestReviews.filter((r) => r.status === "sunset_pending").length,
    ventures: latestReviews.map((r) => ({
      ventureIdeaId: r.ventureIdeaId,
      decision: r.decision,
      status: r.status,
      score: r.score,
      netCents: r.netCents,
    })),
  };

  // #192 external account onboarding: surface how many services still need the owner + the hygiene pulse
  // (rotation due, capabilities offline). Zeroed when onboarding is off/unwired so the console renders
  // before the feature is configured. Blocked setup also shows in `pendingApprovals` (it parks a #13
  // approval) — this pane is the at-a-glance count + the credential-hygiene signal.
  const setup: SetupView = {
    pendingSetup: input.setup?.pendingSetup ?? 0,
    connected: input.setup?.connected ?? 0,
    rotationDue: input.setup?.rotationDue ?? 0,
    offlineCapabilities: input.setup?.offlineCapabilities ?? 0,
    needed: input.setup?.needed ?? 0,
  };

  // #193 self-healing ops: per-venture incidents + watchdog stuck agents. Zeroed when unwired.
  const selfHealingOps: SelfHealingOpsSnapshot = input.selfHealingOps ?? {
    openIncidents: 0,
    escalatedIncidents: 0,
    stuckAgents: 0,
  };

  // #253 proof scorecard: one tile per marketing department with a real, sourced outcome metric (articles
  // live, emails sent, blended CAC, …) or "not connected" where the source isn't wired. Pure + always-on:
  // the builder emits all seven tiles even when no readings were gathered, so the console never hides the
  // honesty gap behind an empty pane.
  const proofScorecard = buildProofScorecard({ readings: input.proofReadings });

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
  if (buildLoopEscalated > 0) {
    reasons.push(`${pluralize(buildLoopEscalated, "self-shipping run")} escalated (owner review)`);
  }
  if (moat.enabled && moat.flaggedStagnant > 0) {
    reasons.push(
      `${pluralize(moat.flaggedStagnant, "venture")} with stagnant moat (no accrual in ${moatWindowDays}d)`,
    );
  }
  if (constitution.openViolations > 0) {
    reasons.push(`${pluralize(constitution.openViolations, "constitution violation")} flagged`);
  }
  if (voice.ticketsNeedingHuman > 0) {
    reasons.push(`${pluralize(voice.ticketsNeedingHuman, "support ticket")} need a human`);
  }
  if (supportSla.breaches > 0) {
    reasons.push(`${pluralize(supportSla.breaches, "support ticket")} past first-response SLA`);
  }
  if (portfolio.enabled && portfolio.sunsetsPendingApproval > 0) {
    reasons.push(`${pluralize(portfolio.sunsetsPendingApproval, "venture sunset")} awaiting approval`);
  }
  if (portfolio.enabled && portfolio.sunsetsRecommended > 0) {
    reasons.push(`${pluralize(portfolio.sunsetsRecommended, "venture")} recommended for sunset`);
  }
  if (setup.pendingSetup > 0) {
    reasons.push(`${pluralize(setup.pendingSetup, "external account")} need setup`);
  }
  if (setup.needed > 0) {
    reasons.push(
      `${pluralize(setup.needed, "account")} to connect before a venture can do real work`,
    );
  }
  if (setup.rotationDue > 0) {
    reasons.push(`${pluralize(setup.rotationDue, "credential")} due for rotation`);
  }
  if (setup.offlineCapabilities > 0) {
    reasons.push(`${pluralize(setup.offlineCapabilities, "capability")} offline (credential revoked)`);
  }
  // #193: an escalated ops incident or a stuck agent turns the fleet-health dot red with the reason.
  if (selfHealingOps.escalatedIncidents > 0) {
    reasons.push(
      `${pluralize(selfHealingOps.escalatedIncidents, "self-healing incident")} escalated (auto-remediation could not close)`,
    );
  }
  if (selfHealingOps.stuckAgents > 0) {
    reasons.push(`${pluralize(selfHealingOps.stuckAgents, "stuck agent")} escalated by the watchdog`);
  }

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
    reliability,
    autonomyBoundaries: { owned: gateBoundaries.owned, history: gateBoundaries.history },
    selfHealing,
    selfHealingOps,
    buildLoop,
    growth,
    discoveryPipeline,
    outreach,
  planning,
    moat,
    constitution,
    voice,
    supportSla,
    portfolio,
    setup,
    proofScorecard,
    attention: { required: reasons.length > 0, reasons },
  };
}
