import {
  aggregateFounderConsole,
  type FounderConsole,
  type MaintenanceSnapshot,
  type PendingApprovalSnapshot,
  type RevenueSnapshot,
  type SelfHealingSnapshot,
  type VentureEvalSnapshot,
} from "./aggregate.js";

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

/** The self-healing flywheel pane (#117). Optional — absent ⇒ the console renders zeroed self-healing. */
export interface FlywheelReader {
  state(workspaceId: string): Promise<SelfHealingSnapshot>;
}

export interface FounderConsoleDeps {
  fleet: FleetReader;
  venture: VentureReader;
  revenue: RevenueReader;
  budget: BudgetReader;
  approvals: ApprovalsReader;
  switches: SwitchesReader;
  /** Self-healing flywheel (#117) — optional, read-only. */
  flywheel?: FlywheelReader;
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

    const [ventures, revenue, usage, approvals, killSwitch, maintenance, selfHealing] = await Promise.all([
      this.deps.venture.evaluations(workspaceId),
      this.deps.revenue.summary(workspaceId),
      this.deps.budget.usage(workspaceId, window),
      this.deps.approvals.pending(workspaceId),
      this.deps.switches.killSwitch(workspaceId),
      this.deps.switches.maintenance(),
      this.deps.flywheel?.state(workspaceId) ?? Promise.resolve(undefined),
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
      selfHealing,
    });
  }
}
