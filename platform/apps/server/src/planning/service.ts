import type { PlanningCaps } from "./caps.js";
import { decidePlanningDispatch, type PlanningDispatchAction } from "./decide.js";
import { deriveRice, rankBacklog } from "./rice.js";
import { draftSpec } from "./spec.js";
import type {
  BacklogEvidence,
  BacklogItemRecord,
  BacklogSource,
  PlanningSpecRecord,
  RankedBacklogItem,
} from "./types.js";

/**
 * The Product Planning Loop IO orchestrator (#115, ADR-0115), modelled on the #117 FlywheelEngine: side
 * effects here, pure decision/rank/spec logic in `decide.ts`/`rice.ts`/`spec.ts`. Every collaborator is
 * an injected seam so the loop is unit/integration-tested against fakes (no real launcher, no model
 * spend); `default.ts` wires the production implementations (the venture-gated #96 launcher, the #13
 * queue, the real repos). Recording items + reading the ranked backlog are always available; the
 * `caps.enabled` flag gates only the proactive tick.
 */

// ---- store seams (real impls wrap `db/repositories/planning.ts`) -------------------------------

export interface BacklogStore {
  insert(input: {
    workspaceId: string;
    ideaId: string | null;
    title: string;
    description: string;
    source: BacklogSource;
    sourceRef: string;
    reach: number;
    impact: number;
    confidencePct: number;
    effort: number;
    isPivot: boolean;
    targetChannelId: string | null;
    targetAgentMemberId: string | null;
  }): Promise<BacklogItemRecord>;
  get(workspaceId: string, id: string): Promise<BacklogItemRecord | undefined>;
  list(workspaceId: string): Promise<BacklogItemRecord[]>;
  update(
    workspaceId: string,
    id: string,
    patch: { status?: BacklogItemRecord["status"]; specId?: string; approvalRequestId?: string },
    now: Date,
  ): Promise<BacklogItemRecord | undefined>;
}

export interface SpecStore {
  insert(input: {
    workspaceId: string;
    backlogItemId: string;
    title: string;
    body: string;
  }): Promise<PlanningSpecRecord>;
  getForItem(workspaceId: string, backlogItemId: string): Promise<PlanningSpecRecord | undefined>;
  list(workspaceId: string): Promise<PlanningSpecRecord[]>;
  linkSession(
    workspaceId: string,
    id: string,
    sessionId: string,
    now: Date,
  ): Promise<PlanningSpecRecord | undefined>;
  linkApproval(
    workspaceId: string,
    id: string,
    approvalRequestId: string,
    now: Date,
  ): Promise<PlanningSpecRecord | undefined>;
}

/** The build-session launch seam — the venture-gated #96 `AutonomyLauncher` satisfies it in `default.ts`. */
export interface SpecDispatcher {
  dispatch(input: {
    workspaceId: string;
    item: BacklogItemRecord;
    spec: PlanningSpecRecord;
  }): Promise<{ id: string }>;
}

/** The #13 approval queue for a sensitive dispatch (pivot / over-budget / not #95-allowed). */
export interface SpecApprovalQueue {
  enqueue(input: {
    workspaceId: string;
    item: BacklogItemRecord;
    spec: PlanningSpecRecord;
    reason: string;
  }): Promise<{ id: string }>;
}

/** Optional #71 dollar-ceiling meter: charge a dispatch's cost so planning + sessions share one budget. */
export interface PlanningUsageMeter {
  charge(workspaceId: string, costCents: number, now: Date): Promise<void>;
}

export interface PlanningDeps {
  backlog: BacklogStore;
  specs: SpecStore;
  dispatcher: SpecDispatcher;
  approvals: SpecApprovalQueue;
  caps: (workspaceId: string) => PlanningCaps;
  /** Whether a #95 policy rule auto-approves planning dispatch for this workspace (sensitive-by-default). */
  autoDispatchAllowed: (workspaceId: string) => Promise<boolean>;
  /** Whether the workspace has met/passed its #71 dollar ceiling (skip the auto path). */
  budgetExhausted: (workspaceId: string, now: Date) => Promise<boolean>;
  /** The #17 kill switch for a workspace (skips the auto path). */
  killSwitch: (workspaceId: string) => Promise<boolean>;
  /** Optional #71 usage meter — charge `caps.dispatchCostCents` after an auto-dispatch. */
  usage?: PlanningUsageMeter;
  /** Workspaces with non-terminal backlog items (the tickAll work-list). */
  activeWorkspaces?: () => Promise<string[]>;
  /** Optional maintenance-pause check (#99) — when true, `tickAll()` skips BEFORE any DB call. */
  maintenancePaused?: () => Promise<boolean>;
  now?: () => Date;
}

/** One action the planning tick applied to a backlog item. */
export interface PlanningTickAction {
  itemId: string;
  specId: string;
  action: PlanningDispatchAction;
  reason: string;
  sessionId?: string;
  approvalRequestId?: string;
}

export interface PlanningTickResult {
  workspaceId: string;
  skipped?: "disabled";
  actions: PlanningTickAction[];
}

export class PlanningService {
  private readonly deps: PlanningDeps;
  private readonly now: () => Date;

  constructor(deps: PlanningDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Record a backlog item from evidence. The raw counts are turned into the stored RICE inputs by the
   * pure {@link deriveRice} ("reach/impact/confidence derived from evidence counts; effort from the
   * agent estimate"). Always available, tenant-scoped.
   */
  async addItem(
    workspaceId: string,
    input: {
      title: string;
      description?: string;
      source: BacklogSource;
      sourceRef?: string;
      ideaId?: string | null;
      isPivot?: boolean;
      evidence: BacklogEvidence;
      targetChannelId?: string | null;
      targetAgentMemberId?: string | null;
    },
  ): Promise<BacklogItemRecord> {
    const rice = deriveRice(input.evidence);
    return this.deps.backlog.insert({
      workspaceId,
      ideaId: input.ideaId ?? null,
      title: input.title,
      description: input.description ?? "",
      source: input.source,
      sourceRef: input.sourceRef ?? "",
      reach: rice.reach,
      impact: rice.impact,
      confidencePct: rice.confidencePct,
      effort: rice.effort,
      isPivot: input.isPivot ?? false,
      targetChannelId: input.targetChannelId ?? null,
      targetAgentMemberId: input.targetAgentMemberId ?? null,
    });
  }

  /** The RICE-ranked backlog (the #104 roadmap + the route read). Read-only, tenant-scoped. */
  async backlogView(workspaceId: string): Promise<RankedBacklogItem[]> {
    return rankBacklog(await this.deps.backlog.list(workspaceId));
  }

  async listSpecs(workspaceId: string): Promise<PlanningSpecRecord[]> {
    return this.deps.specs.list(workspaceId);
  }

  /**
   * One planning pass over a workspace: re-rank the backlog, then for the top actionable items draft a
   * spec (if needed) and route the dispatch — auto-launch a build session, queue a #13 approval, or skip
   * (budget / kill switch). Default-OFF: a disabled workspace is a no-op.
   */
  async tick(workspaceId: string): Promise<PlanningTickResult> {
    const caps = this.deps.caps(workspaceId);
    const result: PlanningTickResult = { workspaceId, actions: [] };
    if (!caps.enabled) return { ...result, skipped: "disabled" };

    const now = this.now();
    const ranked = rankBacklog(await this.deps.backlog.list(workspaceId));
    // Actionable: still in the funnel (proposed/specced) and not already parked at a human gate.
    const actionable = ranked.filter(
      (r) =>
        (r.item.status === "proposed" || r.item.status === "specced") &&
        !r.item.approvalRequestId,
    );

    const budgetExhausted = await this.deps.budgetExhausted(workspaceId, now);
    const killSwitchEngaged = await this.deps.killSwitch(workspaceId);
    const autoAllowed = await this.deps.autoDispatchAllowed(workspaceId);

    let dispatched = 0;
    for (const ranking of actionable) {
      if (dispatched >= caps.maxDispatchesPerTick) break;

      // (1) ensure a spec exists for the top item (drafting is pure + free).
      let item = ranking.item;
      let spec: PlanningSpecRecord | undefined;
      if (item.status === "proposed") {
        const drafted = draftSpec(item, ranking);
        spec = await this.deps.specs.insert({
          workspaceId,
          backlogItemId: item.id,
          title: drafted.title,
          body: drafted.body,
        });
        const updated = await this.deps.backlog.update(
          workspaceId,
          item.id,
          { status: "specced", specId: spec.id },
          now,
        );
        item = updated ?? { ...item, status: "specced", specId: spec.id };
      } else {
        spec = await this.deps.specs.getForItem(workspaceId, item.id);
        if (!spec) continue; // a specced item with no spec row is anomalous — skip it
      }

      // (2) route the dispatch (pure decision).
      const decision = decidePlanningDispatch({
        isPivot: item.isPivot,
        overEffortBudget: item.effort > caps.autoEffortCeiling,
        autoAllowed,
        budgetExhausted,
        killSwitchEngaged,
      });

      if (decision.action === "skip") {
        // Auto path only (budget / kill switch) — leave the item specced to retry next tick. Counts
        // toward the per-tick budget so a stuck top item doesn't starve the scan of nothing useful.
        result.actions.push({
          itemId: item.id,
          specId: spec.id,
          action: "skip",
          reason: decision.reason,
        });
        dispatched += 1;
        continue;
      }

      if (decision.action === "gate") {
        const req = await this.deps.approvals.enqueue({
          workspaceId,
          item,
          spec,
          reason: decision.reason,
        });
        await this.deps.specs.linkApproval(workspaceId, spec.id, req.id, now);
        await this.deps.backlog.update(workspaceId, item.id, { approvalRequestId: req.id }, now);
        result.actions.push({
          itemId: item.id,
          specId: spec.id,
          action: "gate",
          reason: decision.reason,
          approvalRequestId: req.id,
        });
        dispatched += 1;
        continue;
      }

      // auto: propose the build session through the (venture-gated) launcher.
      const session = await this.deps.dispatcher.dispatch({ workspaceId, item, spec });
      await this.deps.specs.linkSession(workspaceId, spec.id, session.id, now);
      await this.deps.backlog.update(workspaceId, item.id, { status: "dispatched" }, now);
      if (this.deps.usage && caps.dispatchCostCents > 0) {
        await this.deps.usage.charge(workspaceId, caps.dispatchCostCents, now);
      }
      result.actions.push({
        itemId: item.id,
        specId: spec.id,
        action: "auto",
        reason: decision.reason,
        sessionId: session.id,
      });
      dispatched += 1;
    }

    return result;
  }

  /** One pass over every workspace with non-terminal backlog items (the #99-paused background timer). */
  async tickAll(): Promise<void> {
    if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) return;
    const workspaces = (await this.deps.activeWorkspaces?.()) ?? [];
    for (const workspaceId of workspaces) {
      try {
        await this.tick(workspaceId);
      } catch {
        // a single workspace's failure never crashes the loop (the supervisor discipline)
      }
    }
  }
}
