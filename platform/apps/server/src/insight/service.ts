import { rankSource, rankInsight } from "./ranking.js";
import { insightDedupeKey, isCited, suppressedByKill } from "./dedupe.js";
import type { InsightCaps } from "./caps.js";
import { budgetExceeded } from "../scale/usage.js";
import type {
  EvidenceRef,
  Insight,
  InsightInput,
  InsightSource,
  SourceInput,
} from "./types.js";

/**
 * The Insight Miner IO orchestrator (#100), modelled on the #96 `VentureService`: side effects here,
 * pure ranking/dedupe in `ranking.ts`/`dedupe.ts`. Every collaborator is an injected seam so the loop
 * is unit-tested against fakes (no DB, no model spend); `default.ts` wires the production implementations.
 *
 * Only the **agent-session mining path** (`mine`) is gated: it skips when the miner is disabled, when
 * the #17 kill switch is engaged, or when the #71 tenant budget is exhausted — charging the per-pass
 * cost to the same `tenant_usage` window the venture loop uses. Owner-secret intake and source ranking
 * are cheap/pure and ungated.
 */

/** Persistence surface the orchestrator needs (a subset of `db/repositories/insights.ts`). */
export interface InsightRepo {
  createSource(
    input: SourceInput & {
      workspaceId: string;
      evidenceStrength: number;
      createdByMemberId: string | null;
    },
  ): Promise<InsightSource>;
  listSources(workspaceId: string): Promise<InsightSource[]>;
  listCandidateSources(workspaceId: string): Promise<InsightSource[]>;
  setSourceStatus(workspaceId: string, id: string, status: "candidate" | "mined" | "skipped"): Promise<void>;
  createInsight(
    input: Omit<InsightInput, "evidence"> & {
      workspaceId: string;
      score: number;
      dedupeKey: string;
      createdByMemberId: string | null;
    },
  ): Promise<Insight>;
  insertEvidence(workspaceId: string, insightId: string, rows: EvidenceRef[]): Promise<void>;
  listEvidence(workspaceId: string, insightId: string): Promise<EvidenceRef[]>;
  getInsight(workspaceId: string, id: string): Promise<Insight | undefined>;
  listInsights(workspaceId: string): Promise<Insight[]>;
  setInsightStatus(
    workspaceId: string,
    id: string,
    status: "mined" | "promoted" | "killed" | "duplicate",
  ): Promise<void>;
  setInsightPromotion(workspaceId: string, id: string, promotedIdeaId: string): Promise<void>;
}

/**
 * The agent-session mining seam (#100): scrape/analyse a candidate source into structured insights.
 * Deterministic stand-in in `default.ts`; the live web/changelog/LLM provider is the deferred follow-up.
 */
export interface Miner {
  mine(source: InsightSource): Promise<InsightInput[]>;
}

/** #96 SOURCE: turn a promoted insight into a venture idea. Wired to `VentureService.submit`. */
export interface VentureIdeaCreator {
  submit(
    workspaceId: string,
    input: { problem: string; targetUser: string; insight: string; wedge: string; marketPath: string },
    createdByMemberId: string,
  ): Promise<{ id: string }>;
}

/**
 * #15 memory: the killed-angle store. `listKilledKeys` returns the dedupe keys of angles the loop has
 * KILLed (so they never return uncited); `recordKill` writes a killed-angle node when this miner kills
 * an insight.
 */
export interface KilledAngleStore {
  listKilledKeys(workspaceId: string): Promise<string[]>;
  recordKill(input: {
    workspaceId: string;
    dedupeKey: string;
    statement: string;
    reasoning: string;
    createdByMemberId: string | null;
  }): Promise<void>;
}

/** Dollar-ceiling seam (#71 tenant usage) — identical shape to the venture loop's. */
export interface UsageMeter {
  spentCents(workspaceId: string, now: Date): Promise<number>;
  charge(workspaceId: string, costCents: number, now: Date): Promise<void>;
}

export interface InsightMinerDeps {
  repo: InsightRepo;
  miner: Miner;
  ventures: VentureIdeaCreator;
  killedAngles: KilledAngleStore;
  /** Per-workspace resolved insight policy (flag, half-life, mining cost, caps). */
  caps: (workspaceId: string) => InsightCaps;
  /** Dollar-ceiling meter (#71 tenant usage). Default: a no-op meter (cost 0, never bites). */
  usage?: UsageMeter;
  /** The tenant's dollar budget cap in cents (the #71 scale budget). Default: 0 = no budget. */
  scaleBudgetCents?: (workspaceId: string) => number;
  /** The #17 kill switch for the workspace. Default: never engaged. */
  killSwitch?: (workspaceId: string) => Promise<boolean>;
  now?: () => Date;
}

/** Owner-secret intake input (#100 scope 3): a first-class, ungated, no-citation-required artifact. */
export interface OwnerSecretInput {
  statement: string;
  painIntensity: number;
  competitionAbsence: number;
  /** Recency of the observation (defaults to now). */
  observedAt?: Date;
  /** Optional corroborating evidence (an owner secret needs none — the observation is the source). */
  evidence?: EvidenceRef[];
}

/** The result of one mining pass. */
export interface MineResult {
  /** Why the pass was skipped, when it was (null ⇒ it ran). */
  skipped: null | "disabled" | "kill_switch" | "budget";
  insights: Insight[];
  /** Count of candidate insights suppressed as killed-and-uncited (never persisted). */
  suppressed: number;
  /** Cents charged to the tenant for this pass (0 when skipped before the charge). */
  chargedCents: number;
}

/** The result of promoting an insight to a venture idea. */
export interface PromoteResult {
  /** True when the insight was suppressed (a killed-uncited angle) and NOT promoted. */
  suppressed: boolean;
  /** The created venture idea id, or null when suppressed. */
  ideaId: string | null;
}

export interface InsightView {
  insight: Insight;
  evidence: EvidenceRef[];
}

/** Thrown when an insight does not exist in the workspace — the route maps it to 404. */
export class InsightNotFoundError extends Error {
  constructor(message = "insight not found") {
    super(message);
    this.name = "InsightNotFoundError";
  }
}

export class InsightMiner {
  constructor(private readonly deps: InsightMinerDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private get usage(): UsageMeter {
    return this.deps.usage ?? { spentCents: async () => 0, charge: async () => {} };
  }

  private budgetCents(workspaceId: string): number {
    return this.deps.scaleBudgetCents ? this.deps.scaleBudgetCents(workspaceId) : 0;
  }

  private async killSwitchEngaged(workspaceId: string): Promise<boolean> {
    return this.deps.killSwitch ? this.deps.killSwitch(workspaceId) : false;
  }

  /** "List is the strategy": register a candidate source, scored by evidence strength before mining. */
  async addSource(
    workspaceId: string,
    input: SourceInput,
    createdByMemberId: string | null,
  ): Promise<InsightSource> {
    const caps = this.deps.caps(workspaceId);
    const evidenceStrength = rankSource(input, this.now(), caps.freshnessHalfLifeDays);
    return this.deps.repo.createSource({ ...input, workspaceId, evidenceStrength, createdByMemberId });
  }

  /** The ranked candidate source list (strongest evidence first). */
  async listSources(workspaceId: string): Promise<InsightSource[]> {
    return this.deps.repo.listSources(workspaceId);
  }

  /** Every insight for the workspace, highest-score first. */
  async listInsights(workspaceId: string): Promise<Insight[]> {
    return this.deps.repo.listInsights(workspaceId);
  }

  /**
   * #100 scope 3: owner-secret intake. A first-class idea artifact — the only *true* secret source —
   * captured directly with no kill-switch/budget gate (no agent session) and no required citation.
   */
  async captureOwnerSecret(
    workspaceId: string,
    input: OwnerSecretInput,
    createdByMemberId: string | null,
  ): Promise<Insight> {
    const caps = this.deps.caps(workspaceId);
    const freshnessAt = input.observedAt ?? this.now();
    const insightInput: InsightInput = {
      kind: "owner_secret",
      statement: input.statement,
      painIntensity: input.painIntensity,
      competitionAbsence: input.competitionAbsence,
      freshnessAt,
      evidence: input.evidence ?? [],
      sourceId: null,
    };
    return this.persistInsight(workspaceId, insightInput, caps, createdByMemberId);
  }

  /**
   * #100 scope 1+2: mine candidate sources into structured insights (the agent-session path). GATED:
   * skips when the miner is disabled, the #17 kill switch is engaged, or the #71 budget is exhausted;
   * otherwise charges one pass's cost. Suppresses any candidate that repeats a KILLed angle uncited.
   */
  async mine(workspaceId: string, createdByMemberId: string | null = null): Promise<MineResult> {
    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return { skipped: "disabled", insights: [], suppressed: 0, chargedCents: 0 };
    if (await this.killSwitchEngaged(workspaceId)) {
      return { skipped: "kill_switch", insights: [], suppressed: 0, chargedCents: 0 };
    }

    const now = this.now();
    const budget = this.budgetCents(workspaceId);
    const spentBefore = await this.usage.spentCents(workspaceId, now);
    if (budgetExceeded(spentBefore, budget)) {
      return { skipped: "budget", insights: [], suppressed: 0, chargedCents: 0 };
    }
    await this.usage.charge(workspaceId, caps.mineCostCents, now);

    const killedKeys = new Set(await this.deps.killedAngles.listKilledKeys(workspaceId));
    const sources = (await this.deps.repo.listCandidateSources(workspaceId)).filter(
      (s) => s.evidenceStrength >= caps.minSourceStrength,
    );

    const produced: Insight[] = [];
    let suppressed = 0;
    for (const source of sources) {
      if (produced.length >= caps.maxInsightsPerMine) break;
      const candidates = await this.deps.miner.mine(source);
      for (const candidate of candidates) {
        if (produced.length >= caps.maxInsightsPerMine) break;
        const dedupeKey = insightDedupeKey(candidate.statement);
        if (suppressedByKill({ dedupeKey, killedKeys, cited: isCited(candidate.evidence) })) {
          suppressed += 1;
          continue;
        }
        produced.push(await this.persistInsight(workspaceId, candidate, caps, createdByMemberId));
      }
      await this.deps.repo.setSourceStatus(workspaceId, source.id, "mined");
    }

    return { skipped: null, insights: produced, suppressed, chargedCents: caps.mineCostCents };
  }

  /**
   * #100 scope: an insight becomes a venture idea (#96 SOURCE) with a provenance link. A killed-uncited
   * angle is suppressed (marked `duplicate`) and never promoted — killed angles never return uncited.
   */
  async promote(
    workspaceId: string,
    insightId: string,
    framing: { targetUser: string; wedge: string; marketPath: string; problem?: string },
    createdByMemberId: string,
  ): Promise<PromoteResult> {
    const insight = await this.deps.repo.getInsight(workspaceId, insightId);
    if (!insight) throw new InsightNotFoundError();

    const evidence = await this.deps.repo.listEvidence(workspaceId, insightId);
    const killedKeys = await this.deps.killedAngles.listKilledKeys(workspaceId);
    if (suppressedByKill({ dedupeKey: insight.dedupeKey, killedKeys, cited: isCited(evidence) })) {
      await this.deps.repo.setInsightStatus(workspaceId, insightId, "duplicate");
      return { suppressed: true, ideaId: null };
    }

    const idea = await this.deps.ventures.submit(
      workspaceId,
      {
        problem: framing.problem ?? insight.statement,
        targetUser: framing.targetUser,
        insight: insight.statement,
        wedge: framing.wedge,
        marketPath: framing.marketPath,
      },
      createdByMemberId,
    );
    await this.deps.repo.setInsightPromotion(workspaceId, insightId, idea.id);
    return { suppressed: false, ideaId: idea.id };
  }

  /**
   * Kill an insight + record the angle to the #15 memory graph so it never returns uncited. The recorded
   * key is what a later `mine`/`promote` checks against.
   */
  async kill(
    workspaceId: string,
    insightId: string,
    reasoning: string,
    createdByMemberId: string | null,
  ): Promise<void> {
    const insight = await this.deps.repo.getInsight(workspaceId, insightId);
    if (!insight) throw new InsightNotFoundError();
    await this.deps.repo.setInsightStatus(workspaceId, insightId, "killed");
    await this.deps.killedAngles.recordKill({
      workspaceId,
      dedupeKey: insight.dedupeKey,
      statement: insight.statement,
      reasoning,
      createdByMemberId,
    });
  }

  /** Read a full insight view: the insight + its provenance evidence. */
  async get(workspaceId: string, insightId: string): Promise<InsightView> {
    const insight = await this.deps.repo.getInsight(workspaceId, insightId);
    if (!insight) throw new InsightNotFoundError();
    const evidence = await this.deps.repo.listEvidence(workspaceId, insightId);
    return { insight, evidence };
  }

  /** Score + persist an insight and its provenance evidence (shared by mining + owner-secret intake). */
  private async persistInsight(
    workspaceId: string,
    input: InsightInput,
    caps: InsightCaps,
    createdByMemberId: string | null,
  ): Promise<Insight> {
    const score = rankInsight(input, this.now(), caps.freshnessHalfLifeDays);
    const dedupeKey = insightDedupeKey(input.statement);
    const insight = await this.deps.repo.createInsight({
      kind: input.kind,
      statement: input.statement,
      painIntensity: input.painIntensity,
      competitionAbsence: input.competitionAbsence,
      freshnessAt: input.freshnessAt,
      sourceId: input.sourceId,
      workspaceId,
      score,
      dedupeKey,
      createdByMemberId,
    });
    if (input.evidence.length > 0) {
      await this.deps.repo.insertEvidence(workspaceId, insight.id, input.evidence);
    }
    return insight;
  }
}
