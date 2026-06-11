import {
  aggregateFounderConsole,
  type FounderConsole,
  type GateBoundariesSnapshot,
  type MaintenanceSnapshot,
  type MoatVentureSnapshot,
  type PendingApprovalSnapshot,
  type PostmortemLinkView,
  type RevenueSnapshot,
  type SelfHealingSnapshot,
  type GrowthSnapshot,
  type PortfolioReviewSnapshot,
  type VentureEvalSnapshot,
} from "./aggregate.js";
import type { UsageTrendPoint } from "../scale/forecast.js";

/**
 * The Founder Console IO orchestrator (#104, ADR-0050). Declares ONE read seam per data source, gathers
 * them concurrently for a workspace, and hands the structs to the pure {@link aggregateFounderConsole}.
 * No direct DB import — everything is a seam, so the service runs against fakes in unit tests and the
 * real repos in `default.ts`. **Read-only**: every seam is a query; the console never mutates.
 */

/** Live in-flight concurrency (the #71 admission snapshot). */
export interface FleetReader {
  tenantInFlight(workspaceId: string): number;
  globalInFlight(): number;
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

/** The #119 evidence-priced autonomy boundaries: owned classes + the change history. */
export interface GateBoundaryReader {
  boundaries(workspaceId: string): Promise<GateBoundariesSnapshot>;
}

/** The self-healing flywheel pane (#117). Optional — absent ⇒ the console renders zeroed self-healing. */
export interface FlywheelReader {
  state(workspaceId: string): Promise<SelfHealingSnapshot>;
}

/** The growth loop pane (#102). Optional — absent ⇒ the console renders a zeroed growth view. */
export interface GrowthReader {
  state(workspaceId: string): Promise<GrowthSnapshot>;
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

/** Portfolio reviews (#107) + whether the loop is enabled. Optional — absent ⇒ a zeroed portfolio view
 * (works before the subsystem is wired, like the moat reader). */
export interface PortfolioReader {
  reviews(workspaceId: string): Promise<PortfolioReviewSnapshot[]>;
  enabled(workspaceId: string): boolean;
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
  gateBoundaries: GateBoundaryReader;
  /** Self-healing flywheel (#117) — optional, read-only. */
  flywheel?: FlywheelReader;
  /** Growth loop (#102) — optional, read-only. */
  growth?: GrowthReader;
  /** Cost forecast + right-sizing + infra-ceiling inputs (#113). */
  forecast: ForecastReader;
  /** Per-venture moat roll-ups (#103) — optional, read-only. */
  moat?: MoatReader;
  /** Portfolio lifecycle reviews (#107) — optional, read-only. */
  portfolio?: PortfolioReader;
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
      gateBoundaries,
      usageTrend,
      selfHealing,
      growth,
      moat,
      portfolioReviews,
    ] =
      await Promise.all([
        this.deps.venture.evaluations(workspaceId),
        this.deps.revenue.summary(workspaceId),
        this.deps.budget.usage(workspaceId, window),
        this.deps.approvals.pending(workspaceId),
        this.deps.switches.killSwitch(workspaceId),
        this.deps.switches.maintenance(),
        this.deps.postmortems?.recent(workspaceId) ?? Promise.resolve([]),
        this.deps.gateBoundaries.boundaries(workspaceId),
        this.deps.forecast.trend(workspaceId, now),
        this.deps.flywheel?.state(workspaceId) ?? Promise.resolve(undefined),
        this.deps.growth?.state(workspaceId) ?? Promise.resolve(undefined),
        this.deps.moat?.portfolio(workspaceId) ?? Promise.resolve([]),
        this.deps.portfolio?.reviews(workspaceId) ?? Promise.resolve([]),
      ]);

    return aggregateFounderConsole({
      workspaceId,
      nowMs: now.getTime(),
      fleet: {
        tenantInFlight: this.deps.fleet.tenantInFlight(workspaceId),
        globalInFlight: this.deps.fleet.globalInFlight(),
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
      gateBoundaries,
      selfHealing,
      growth,
      usageTrend,
      forecastWindow: this.deps.forecast.forecastWindow(now),
      infraBudgetCeilingCents: this.deps.forecast.infraBudgetCeilingCents(workspaceId),
      tenantConcurrency: this.deps.forecast.tenantConcurrency(workspaceId),
      moat,
      moatEnabled: this.deps.moat?.enabled(workspaceId) ?? false,
      moatWindowDays: this.deps.moat?.windowDays(workspaceId) ?? 30,
      portfolio: portfolioReviews,
      portfolioEnabled: this.deps.portfolio?.enabled(workspaceId) ?? false,
    });
  }
}
