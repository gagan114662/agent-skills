import type { VentureMemoryCaps } from "./caps.js";
import {
  composeVentureBrief,
  toVentureEntry,
  ventureEntity,
  ventureMemoryContent,
  ventureMemoryDedupeKey,
  type RawVentureNode,
} from "./memory.js";
import { computeOkrDrift, type OkrDrift } from "./okr.js";
import { decideWeeklyPlan, type WeeklyPlanDraft } from "./plan.js";
import { distillPlaybook, matchPlaybooks, type PlaybookWin } from "./playbook.js";
import { dedupeEntries, reviewStaleness, type StalenessReview } from "./hygiene.js";
import type {
  OkrRecord,
  PlanItem,
  PlanRecord,
  PlaybookRecord,
  VentureMemoryEntry,
  VentureMemoryKind,
} from "./types.js";

/**
 * Venture Memory & Planning IO orchestrator (#197, ADR-0197), modelled on the #115 PlanningService:
 * side effects here, pure decision/compose logic in `memory`/`okr`/`plan`/`playbook`/`hygiene`. Every
 * collaborator is an injected seam so the loop is unit/integration-tested against fakes (no real
 * launcher, no model spend); `default.ts` wires the production implementations (the #15 memories repo,
 * the #197 OKR/plan/playbook repos, the #106 verifier reader, the #96 scorecard, the #115 backlog sink,
 * the #13 queue). Recording memory/OKRs + reading beliefs/OKRs/plans is ALWAYS available; `caps.enabled`
 * gates only the proactive weekly planning tick.
 *
 * The default pace target for OKR drift: a verified key result at ≥ 50% of target reads `on_track`,
 * below reads `behind`. Pace is a heuristic; the premortem-critical signal — `unverified` vs verified —
 * does not depend on it.
 */
const OKR_PACE_TARGET = 0.5;

// ---- store seams (real impls wrap the repos) ---------------------------------------------------

export interface VentureMemoryStore {
  /** Idempotent record of one venture memory into the #15 `memories` table (dedupe-keyed). */
  record(input: {
    workspaceId: string;
    ideaId: string;
    kind: VentureMemoryKind;
    text: string;
    why?: string | null;
    sourceRef?: string | null;
    createdByMemberId?: string | null;
  }): Promise<{ id: string; created: boolean }>;
  /** The venture's raw memory nodes (newest first); `includeStale` surfaces superseded ones. */
  nodes(workspaceId: string, ideaId: string, includeStale?: boolean): Promise<RawVentureNode[]>;
}

export interface OkrStore {
  insert(input: {
    workspaceId: string;
    ideaId: string;
    objective: string;
    keyResults: OkrRecord["keyResults"];
    periodKey?: string;
  }): Promise<OkrRecord>;
  listForVenture(workspaceId: string, ideaId: string): Promise<OkrRecord[]>;
}

export interface PlanStore {
  upsert(input: {
    workspaceId: string;
    ideaId: string;
    weekKey: string;
    goNoGo: PlanRecord["goNoGo"];
    rationale: string;
    premortemCited: boolean;
    items: PlanItem[];
  }): Promise<{ plan: PlanRecord; created: boolean }>;
  linkApproval(
    workspaceId: string,
    id: string,
    approvalRequestId: string,
    now: Date,
  ): Promise<PlanRecord | undefined>;
}

export interface PlaybookStore {
  upsert(input: {
    workspaceId: string;
    category: string;
    pattern: string;
    provenance: PlaybookRecord["provenance"];
    dedupeKey: string;
  }): Promise<{ playbook: PlaybookRecord; created: boolean }>;
  list(workspaceId: string): Promise<PlaybookRecord[]>;
}

/** The ventures (idea ids + optional category) the weekly tick plans over — the #96 evaluations. */
export interface VentureListItem {
  ideaId: string;
  category?: string | null;
  segment?: string | null;
  targetUser?: string | null;
}

export interface VentureLister {
  ventures(workspaceId: string): Promise<VentureListItem[]>;
}

/** Externally-verified (#106) + self-reported (#96) signal for the go/no-go. */
export interface ScorecardReader {
  /** Count of externally-verified (#106) metric receipts the venture has — the ONLY go/no-go input. */
  verifiedMetricCount(workspaceId: string, ideaId: string): Promise<number>;
  /** The latest #96 adversarial score (context only — never flips go/no-go alone). */
  latestScore(workspaceId: string, ideaId: string): Promise<number | null>;
}

/** The #115 backlog: read open titles (dedupe) + flow approved items in (auto-dispatch). */
export interface BacklogSink {
  openTitles(workspaceId: string, ideaId: string): Promise<string[]>;
}

/** The #13 approval queue for a drafted weekly plan (lands in the #173 decision queue). */
export interface PlanApprovalQueue {
  enqueue(input: {
    workspaceId: string;
    ideaId: string;
    plan: PlanRecord;
  }): Promise<{ id: string }>;
}

export interface VentureMemoryDeps {
  caps: (workspaceId: string) => VentureMemoryCaps;
  memory: VentureMemoryStore;
  okrs: OkrStore;
  plans: PlanStore;
  playbooks: PlaybookStore;
  ventures: VentureLister;
  scorecard: ScorecardReader;
  backlog: BacklogSink;
  approvals: PlanApprovalQueue;
  /** The #17 kill switch — halts the proactive tick (no new work while the company is stopped). */
  killSwitch: (workspaceId: string) => Promise<boolean>;
  /** Workspaces with at least one venture — the tickAll work-list. */
  activeWorkspaces?: () => Promise<string[]>;
  /** Optional maintenance-pause check (#99) — when true, `tickAll()` skips BEFORE any DB call. */
  maintenancePaused?: () => Promise<boolean>;
  now?: () => Date;
}

/** One action the weekly tick took for a venture. */
export interface VenturePlanTickAction {
  ideaId: string;
  weekKey: string;
  planId: string;
  drafted: boolean;
  goNoGo: PlanRecord["goNoGo"];
  itemCount: number;
  approvalRequestId?: string;
}

export interface VenturePlanTickResult {
  workspaceId: string;
  skipped?: "disabled" | "kill_switch";
  actions: VenturePlanTickAction[];
}

export class VentureMemoryService {
  private readonly deps: VentureMemoryDeps;
  private readonly now: () => Date;

  constructor(deps: VentureMemoryDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  // ---- venture memory (always available) -------------------------------------------------------

  /** Record one venture memory (a session writing what it learned). Idempotent + tenant-scoped. */
  async recordMemory(input: {
    workspaceId: string;
    ideaId: string;
    kind: VentureMemoryKind;
    text: string;
    why?: string | null;
    sourceRef?: string | null;
    createdByMemberId?: string | null;
  }): Promise<{ id: string; created: boolean }> {
    return this.deps.memory.record(input);
  }

  /** The venture's current beliefs (fresh, deduped). The retrieval that cures goldfish sessions. */
  async recallMemories(workspaceId: string, ideaId: string): Promise<VentureMemoryEntry[]> {
    const nodes = await this.deps.memory.nodes(workspaceId, ideaId, false);
    const entries = nodes.map(toVentureEntry).filter((e): e is VentureMemoryEntry => e !== null);
    return dedupeEntries(entries);
  }

  /** Record a venture OKR (the owner/session declares 2–3 measurable objectives). Tenant-scoped. */
  async recordOkr(input: {
    workspaceId: string;
    ideaId: string;
    objective: string;
    keyResults: OkrRecord["keyResults"];
    periodKey?: string;
  }): Promise<OkrRecord> {
    return this.deps.okrs.insert(input);
  }

  /** The OKR drift for a venture (every brief + report surfaces this). */
  async okrDrift(workspaceId: string, ideaId: string): Promise<OkrDrift[]> {
    const okrs = await this.deps.okrs.listForVenture(workspaceId, ideaId);
    return okrs.map((o) => computeOkrDrift(o, OKR_PACE_TARGET));
  }

  /**
   * The venture brief injected into a new session's context (AC1) — memory + OKR drift, bounded by caps.
   * Empty string for a brand-new venture (the caller skips injection).
   */
  async sessionBrief(workspaceId: string, ideaId: string): Promise<string> {
    const caps = this.deps.caps(workspaceId);
    const [memories, okrDrift] = await Promise.all([
      this.recallMemories(workspaceId, ideaId),
      this.okrDrift(workspaceId, ideaId),
    ]);
    return composeVentureBrief({ ideaId, memories, okrDrift, maxPerKind: caps.maxBriefPerKind });
  }

  /** The owner-visible "what does it believe" surface (AC5): fresh / superseded / needs-review. */
  async beliefs(workspaceId: string, ideaId: string): Promise<StalenessReview> {
    const caps = this.deps.caps(workspaceId);
    const nodes = await this.deps.memory.nodes(workspaceId, ideaId, true);
    const entries = nodes.map(toVentureEntry).filter((e): e is VentureMemoryEntry => e !== null);
    return reviewStaleness(dedupeEntries(entries), this.now().getTime(), caps.staleAfterDays);
  }

  // ---- playbooks (always available to read; distillation happens in the tick) ------------------

  /** Distill an externally-verified win into an anonymized playbook (null if no #106 receipt). */
  async recordPlaybook(
    workspaceId: string,
    win: PlaybookWin,
  ): Promise<{ playbook: PlaybookRecord; created: boolean } | null> {
    const distilled = distillPlaybook(win);
    if (!distilled) return null;
    return this.deps.playbooks.upsert({
      workspaceId,
      category: distilled.category,
      pattern: distilled.pattern,
      provenance: distilled.provenance,
      dedupeKey: distilled.dedupeKey,
    });
  }

  async listPlaybooks(workspaceId: string): Promise<PlaybookRecord[]> {
    return this.deps.playbooks.list(workspaceId);
  }

  // ---- the weekly planning tick (gated) --------------------------------------------------------

  /** Draft + gate one venture's weekly plan (pure decision + persistence + #13). */
  private async planVenture(
    workspaceId: string,
    venture: VentureListItem,
    weekKey: string,
    caps: VentureMemoryCaps,
    allPlaybooks: PlaybookRecord[],
  ): Promise<VenturePlanTickAction> {
    const [okrDrift, memories, verifiedMetricCount, selfReportedScore, openBacklogTitles] =
      await Promise.all([
        this.okrDrift(workspaceId, venture.ideaId),
        this.recallMemories(workspaceId, venture.ideaId),
        this.deps.scorecard.verifiedMetricCount(workspaceId, venture.ideaId),
        this.deps.scorecard.latestScore(workspaceId, venture.ideaId),
        this.deps.backlog.openTitles(workspaceId, venture.ideaId),
      ]);

    const candidates = matchPlaybooks(
      allPlaybooks,
      {
        ideaId: venture.ideaId,
        category: venture.category ?? null,
        segment: venture.segment ?? null,
        targetUser: venture.targetUser ?? null,
      },
      caps.maxPlaybookCandidates,
    ).map((p) => ({ id: p.id, category: p.category, pattern: p.pattern }));

    const draft: WeeklyPlanDraft = decideWeeklyPlan({
      ideaId: venture.ideaId,
      weekKey,
      verifiedMetricCount,
      selfReportedScore,
      okrDrift,
      memories,
      playbooks: candidates,
      openBacklogTitles,
      maxItems: caps.maxPlanItems,
    });

    const { plan, created } = await this.deps.plans.upsert({
      workspaceId,
      ideaId: venture.ideaId,
      weekKey,
      goNoGo: draft.goNoGo,
      rationale: draft.rationale,
      premortemCited: draft.premortemCited,
      items: draft.items,
    });

    const action: VenturePlanTickAction = {
      ideaId: venture.ideaId,
      weekKey,
      planId: plan.id,
      drafted: created,
      goNoGo: plan.goNoGo,
      itemCount: plan.items.length,
    };

    // Only a freshly-drafted plan with items + no prior gate enqueues a #13 request (idempotent week).
    if (created && plan.items.length > 0 && !plan.approvalRequestId) {
      const req = await this.deps.approvals.enqueue({ workspaceId, ideaId: venture.ideaId, plan });
      await this.deps.plans.linkApproval(workspaceId, plan.id, req.id, this.now());
      action.approvalRequestId = req.id;
    }
    return action;
  }

  /** One weekly planning pass over a workspace: draft + gate each venture's plan. Default-OFF. */
  async tick(workspaceId: string): Promise<VenturePlanTickResult> {
    const caps = this.deps.caps(workspaceId);
    const result: VenturePlanTickResult = { workspaceId, actions: [] };
    if (!caps.enabled) return { ...result, skipped: "disabled" };
    if (await this.deps.killSwitch(workspaceId)) return { ...result, skipped: "kill_switch" };

    const weekKey = isoWeekKey(this.now());
    const [ventures, allPlaybooks] = await Promise.all([
      this.deps.ventures.ventures(workspaceId),
      this.deps.playbooks.list(workspaceId),
    ]);
    for (const venture of ventures) {
      try {
        result.actions.push(
          await this.planVenture(workspaceId, venture, weekKey, caps, allPlaybooks),
        );
      } catch {
        // a single venture's failure never crashes the workspace pass (the supervisor discipline)
      }
    }
    return result;
  }

  async tickAll(): Promise<void> {
    if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) return;
    const workspaces = (await this.deps.activeWorkspaces?.()) ?? [];
    for (const workspaceId of workspaces) {
      try {
        await this.tick(workspaceId);
      } catch {
        // a single workspace's failure never crashes the loop
      }
    }
  }
}

/** ISO-week `YYYY-Www` (Mon-based) — the weekly plan's idempotency key (mirrors #173 `weeklyPeriodKey`). */
export function isoWeekKey(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// re-export for default.ts wiring convenience
export { ventureEntity, ventureMemoryContent, ventureMemoryDedupeKey };
