import {
  aggregateFounderConsole,
  type FounderConsole,
  type GateBoundariesSnapshot,
  type MaintenanceSnapshot,
  type MoatVentureSnapshot,
  type PendingApprovalSnapshot,
  type PlanningSnapshot,
  type PostmortemLinkView,
  type ReliabilityInsightsView,
  type RevenueSnapshot,
  type SelfHealingSnapshot,
  type SelfHealingOpsSnapshot,
  type BuildLoopSnapshot,
  type GrowthSnapshot,
  type DiscoveryPipelineSnapshot,
  type PortfolioReviewSnapshot,
  type VentureEvalSnapshot,
  type ConstitutionSnapshot,
  type VoiceSnapshot,
  type SupportSlaSnapshot,
  type SetupSnapshot,
} from "./aggregate.js";
import type { UsageTrendPoint } from "../scale/forecast.js";

/**
 * The Founder Console IO orchestrator (#104, ADR-0050). Declares ONE read seam per data source, gathers
 * them concurrently for a workspace, and hands the structs to the pure {@link aggregateFounderConsole}.
 * No direct DB import — everything is a seam, so the service runs against fakes in unit tests and the
 * real repos in `default.ts`. **Read-only**: every seam is a query; the console never mutates.
 */

/**
 * Live in-flight concurrency. `tenantInFlight` is the durable count of the workspace's live (running /
 * provisioning) sessions from the DB (#230) — NOT the in-memory #71 admission counter, which both
 * resets to 0 on every deploy and (the #230 bug) reads 0 the instant a spawn-and-die session releases
 * its slot, lying that nothing ran. `globalInFlight` stays the admission snapshot (fleet capacity).
 */
export interface FleetReader {
  tenantInFlight(workspaceId: string): Promise<number> | number;
  globalInFlight(): Promise<number> | number;
}

/** The venture pipeline (#96) — all evaluations for the workspace, any status. */
export interface VentureReader {
  evaluations(workspaceId: string): Promise<VentureEvalSnapshot[]>;
}

/** Revenue + willingness-to-pay evidence (#98). */
export interface RevenueReader {
  summary(workspaceId: string): Promise<RevenueSnapshot>;
}

/** Current-window usage + the resolved budget cap (#71). */
export interface BudgetReader {
  /** The window key (UTC `YYYY-MM`) the usage is read for. */
  window(now: Date): string;
  usage(
    workspaceId: string,
    window: string,
  ): Promise<{ sessionsStarted: number; computeSeconds: number; estimatedCostCents: number }>;
  budgetCents(workspaceId: string): number;
}

/** The pending #13 approval queue. */
export interface ApprovalsReader {
  pending(workspaceId: string): Promise<PendingApprovalSnapshot[]>;
}

/** The two safety switches: the per-workspace kill switch (#17) + the global maintenance flag (#99). */
export interface SwitchesReader {
  killSwitch(workspaceId: string): Promise<boolean>;
  maintenance(): Promise<MaintenanceSnapshot>;
}

/** Recent SRE postmortems (#112) for the workspace, newest first. */
export interface PostmortemsReader {
  recent(workspaceId: string): Promise<PostmortemLinkView[]>;
}

/** Reliability insights (#148) off `sre_incidents`. Optional — absent ⇒ the console renders a zeroed pane. */
export interface ReliabilityReader {
  insights(workspaceId: string): Promise<ReliabilityInsightsView>;
}

/** The #119 evidence-priced autonomy boundaries: owned classes + the change history. */
export interface GateBoundaryReader {
  boundaries(workspaceId: string): Promise<GateBoundariesSnapshot>;
}

/** The self-healing flywheel pane (#117). Optional — absent ⇒ the console renders zeroed self-healing. */
export interface FlywheelReader {
  state(workspaceId: string): Promise<SelfHealingSnapshot>;
}

/** The self-healing OPS signal (#193). Optional — absent ⇒ a zeroed ops snapshot (no fleet-health red). */
export interface SelfHealingOpsReader {
  snapshot(workspaceId: string): Promise<SelfHealingOpsSnapshot>;
}

/** The self-shipping loop pane (#172). Optional — absent ⇒ the console renders a zeroed build-loop pane. */
export interface BuildLoopReader {
  state(workspaceId: string): Promise<BuildLoopSnapshot>;
}

/** The growth loop pane (#102). Optional — absent ⇒ the console renders a zeroed growth view. */
export interface GrowthReader {
  state(workspaceId: string): Promise<GrowthSnapshot>;
}

/** The Customer Discovery GTM pipeline pane (#222). Optional — absent ⇒ a zeroed pipeline (all stages 0). */
export interface DiscoveryReader {
  pipeline(workspaceId: string): Promise<DiscoveryPipelineSnapshot>;
}

/** The planning roadmap pane (#115). Optional — absent ⇒ the console renders an empty roadmap. */
export interface PlanningReader {
  state(workspaceId: string): Promise<PlanningSnapshot>;
}

/** Cost-forecast inputs (#113): the usage trend + the resolved caps the projection/right-sizing read. */
export interface ForecastReader {
  /** Recent per-window usage (#71 `tenant_usage`), oldest→newest, for the forecast lookback. */
  trend(workspaceId: string, now: Date): Promise<UsageTrendPoint[]>;
  /** The window the forecast projects (the next calendar month). */
  forecastWindow(now: Date): string;
  /** The resolved infra budget ceiling in cents (#113, links #108); 0 = no ceiling. */
  infraBudgetCeilingCents(workspaceId: string): number;
  /** The tenant's in-flight cap (#71) for the right-sizing utilization; 0 = unlimited. */
  tenantConcurrency(workspaceId: string): number;
}

/** Per-venture moat roll-ups (#103) + whether stagnation flagging is on. Optional — absent ⇒ the
 * console renders a zeroed moat view (works before the subsystem is wired). */
export interface MoatReader {
  portfolio(workspaceId: string): Promise<MoatVentureSnapshot[]>;
  enabled(workspaceId: string): boolean;
  windowDays(workspaceId: string): number;
}

/** Open constitution violations (#146). Optional — absent ⇒ the console renders a zeroed view. */
export interface ConstitutionReader {
  openViolations(workspaceId: string): Promise<ConstitutionSnapshot>;
}

/** The Customer Voice pane (#114). Optional — absent ⇒ the console renders a zeroed voice view. */
export interface VoiceReader {
  snapshot(workspaceId: string): Promise<VoiceSnapshot>;
}

/** The Support Desk SLA pane (#190). Optional — absent ⇒ the console renders a zeroed SLA view. */
export interface SupportSlaReader {
  snapshot(workspaceId: string): Promise<SupportSlaSnapshot>;
}

/** Portfolio reviews (#107) + whether the loop is enabled. Optional — absent ⇒ a zeroed portfolio view
 * (works before the subsystem is wired, like the moat reader). */
export interface PortfolioReader {
  reviews(workspaceId: string): Promise<PortfolioReviewSnapshot[]>;
  enabled(workspaceId: string): boolean;
}

/** The external account onboarding roll-up (#192). Optional — absent ⇒ a zeroed setup pane. */
export interface SetupReader {
  snapshot(workspaceId: string): Promise<SetupSnapshot>;
}

export interface FounderConsoleDeps {
  fleet: FleetReader;
  venture: VentureReader;
  revenue: RevenueReader;
  budget: BudgetReader;
  approvals: ApprovalsReader;
  switches: SwitchesReader;
  /** Optional SRE postmortems reader (#112). Absent ⇒ none surfaced (the loop is off / unwired). */
  postmortems?: PostmortemsReader;
  /** Optional reliability insights reader (#148). Absent ⇒ a zeroed reliability pane. */
  reliability?: ReliabilityReader;
  gateBoundaries: GateBoundaryReader;
  /** Self-healing flywheel (#117) — optional, read-only. */
  flywheel?: FlywheelReader;
  /** Self-healing OPS signal (#193) — optional, read-only (open incidents + stuck agents). */
  selfHealingOps?: SelfHealingOpsReader;
  /** Self-shipping loop (#172) — optional, read-only. */
  buildLoop?: BuildLoopReader;
  /** Growth loop (#102) — optional, read-only. */
  growth?: GrowthReader;
  /** Customer Discovery GTM pipeline (#222) — optional, read-only. */
  discovery?: DiscoveryReader;
  /** Product Planning Loop roadmap (#115) — optional, read-only. */
  planning?: PlanningReader;
  /** Cost forecast + right-sizing + infra-ceiling inputs (#113). */
  forecast: ForecastReader;
  /** Per-venture moat roll-ups (#103) — optional, read-only. */
  moat?: MoatReader;
  /** Open constitution violations (#146) — optional, read-only. */
  constitution?: ConstitutionReader;
  /** Customer Voice roll-up (#114) — optional, read-only. */
  voice?: VoiceReader;
  /** Support Desk SLA roll-up (#190) — optional, read-only. */
  supportSla?: SupportSlaReader;
  /** Portfolio lifecycle reviews (#107) — optional, read-only. */
  portfolio?: PortfolioReader;
  /** External account onboarding roll-up (#192) — optional, read-only. */
  setup?: SetupReader;
  /** Injectable clock (tests pin it). */
  now?: () => Date;
}

export class FounderConsoleService {
  private readonly deps: FounderConsoleDeps;
  private readonly now: () => Date;

  constructor(deps: FounderConsoleDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Gather every subsystem's read-struct for `workspaceId` and roll them up into the console view. */
  async get(workspaceId: string): Promise<FounderConsole> {
    const now = this.now();
    const window = this.deps.budget.window(now);

    const [
      ventures,
      revenue,
      usage,
      approvals,
      killSwitch,
      maintenance,
      postmortems,
      reliability,
      gateBoundaries,
      usageTrend,
      selfHealing,
      buildLoop,
      growth,
      discoveryPipeline,
      planning,
      moat,
      constitution,
      voice,
      supportSla,
      portfolioReviews,
      setup,
      selfHealingOps,
    ] =
      await Promise.all([
        this.deps.venture.evaluations(workspaceId),
        this.deps.revenue.summary(workspaceId),
        this.deps.budget.usage(workspaceId, window),
        this.deps.approvals.pending(workspaceId),
        this.deps.switches.killSwitch(workspaceId),
        this.deps.switches.maintenance(),
        this.deps.postmortems?.recent(workspaceId) ?? Promise.resolve([]),
        this.deps.reliability?.insights(workspaceId) ?? Promise.resolve(undefined),
        this.deps.gateBoundaries.boundaries(workspaceId),
        this.deps.forecast.trend(workspaceId, now),
        this.deps.flywheel?.state(workspaceId) ?? Promise.resolve(undefined),
        this.deps.buildLoop?.state(workspaceId) ?? Promise.resolve(undefined),
        this.deps.growth?.state(workspaceId) ?? Promise.resolve(undefined),
        this.deps.discovery?.pipeline(workspaceId) ?? Promise.resolve(undefined),
        this.deps.planning?.state(workspaceId) ?? Promise.resolve(undefined),
        this.deps.moat?.portfolio(workspaceId) ?? Promise.resolve([]),
        this.deps.constitution?.openViolations(workspaceId) ??
          Promise.resolve(undefined),
        this.deps.voice?.snapshot(workspaceId) ?? Promise.resolve(undefined),
        this.deps.supportSla?.snapshot(workspaceId) ?? Promise.resolve(undefined),
        this.deps.portfolio?.reviews(workspaceId) ?? Promise.resolve([]),
        this.deps.setup?.snapshot(workspaceId) ?? Promise.resolve(undefined),
        this.deps.selfHealingOps?.snapshot(workspaceId) ?? Promise.resolve(undefined),
      ]);

    return aggregateFounderConsole({
      workspaceId,
      nowMs: now.getTime(),
      fleet: {
        tenantInFlight: await this.deps.fleet.tenantInFlight(workspaceId),
        globalInFlight: await this.deps.fleet.globalInFlight(),
        sessionsThisWindow: usage.sessionsStarted,
      },
      ventures,
      revenue,
      budget: {
        window,
        estimatedCostCents: usage.estimatedCostCents,
        budgetCents: this.deps.budget.budgetCents(workspaceId),
        computeSeconds: usage.computeSeconds,
        sessionsStarted: usage.sessionsStarted,
      },
      approvals,
      switches: { killSwitch, maintenance },
      postmortems,
      reliability,
      gateBoundaries,
      selfHealing,
      selfHealingOps,
      buildLoop,
      growth,
      discoveryPipeline,
      planning,
      usageTrend,
      forecastWindow: this.deps.forecast.forecastWindow(now),
      infraBudgetCeilingCents: this.deps.forecast.infraBudgetCeilingCents(workspaceId),
      tenantConcurrency: this.deps.forecast.tenantConcurrency(workspaceId),
      moat,
      moatEnabled: this.deps.moat?.enabled(workspaceId) ?? false,
      moatWindowDays: this.deps.moat?.windowDays(workspaceId) ?? 30,
      constitution,
      voice,
      supportSla,
      portfolio: portfolioReviews,
      portfolioEnabled: this.deps.portfolio?.enabled(workspaceId) ?? false,
      setup,
    });
  }
}
