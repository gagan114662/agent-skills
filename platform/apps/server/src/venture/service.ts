import { combineDimensions, gapAngles, scorecardMeanScore, type PersonaScorecard } from "./rubric.js";
import { decideVenture } from "./decide.js";
import { ventureThresholds, type VentureCaps } from "./caps.js";
import { budgetExceeded } from "../scale/usage.js";
import {
  demandScoreFromExternal,
  overlayDemandDimension,
} from "../demand/scorecard-evidence.js";
import type { DemandEvidenceSource } from "../demand/service.js";
import { evaluateLoveGate } from "../constitution/love-gate.js";
import { scoreDecision } from "../constitution/scorer.js";
import type { ConstitutionCaps } from "../constitution/caps.js";
import type { ConstitutionViolation, DecisionStage } from "../constitution/types.js";
import { overlayVoiceDimension, voiceDimensionScore } from "../voice/scorecard-evidence.js";
import type { VoiceEvidenceSource } from "../voice/service.js";
import type {
  Evidence,
  GapList,
  IdeaInput,
  IdeaStatus,
  IterationLogEntry,
  Scorecard,
  Verdict,
  VentureEvaluation,
  VentureIdea,
} from "./types.js";

/**
 * The Venture Loop IO orchestrator (#96), modelled on the #17 AutonomyEngine: side effects here,
 * pure decision/rubric logic in `decide.ts`/`rubric.ts`/`guards.ts`. Every collaborator is an injected
 * seam so the loop is unit-tested against fakes (no DB, no model spend); `default.ts` wires the
 * production implementations. The loop is act → observe → reason → repeat with explicit termination
 * (the spec's loop-engineering discipline).
 */

/** Persistence surface the orchestrator needs (a subset of `db/repositories/venture.ts`). */
export interface VentureRepo {
  createIdea(
    input: IdeaInput & { workspaceId: string; createdByMemberId: string | null },
  ): Promise<VentureIdea>;
  getIdea(workspaceId: string, ideaId: string): Promise<VentureIdea | undefined>;
  updateIdeaStatus(workspaceId: string, ideaId: string, status: IdeaStatus): Promise<void>;
  setIdeaEpic(workspaceId: string, ideaId: string, epicTaskId: string): Promise<void>;
  insertScorecard(input: {
    workspaceId: string;
    ideaId: string;
    iteration: number;
    score: number;
    advocate: PersonaScorecard;
    reviewer: PersonaScorecard;
    reasoning: string;
    expiresAt: Date;
  }): Promise<Scorecard>;
  latestScorecard(workspaceId: string, ideaId: string): Promise<Scorecard | undefined>;
  setScorecardVerdict(
    workspaceId: string,
    scorecardId: string,
    verdict: Verdict,
    funded: boolean,
  ): Promise<void>;
  insertIteration(input: {
    workspaceId: string;
    ideaId: string;
    iteration: number;
    score: number;
    verdict: Verdict;
    gapList: GapList;
    angles: string[];
    evidence: Evidence[];
    workingMemorySummary: string;
  }): Promise<IterationLogEntry>;
  listIterations(workspaceId: string, ideaId: string): Promise<IterationLogEntry[]>;
  // Durable loop state (#96 hardening).
  getOrCreateEvaluation(workspaceId: string, ideaId: string): Promise<VentureEvaluation>;
  getEvaluation(workspaceId: string, ideaId: string): Promise<VentureEvaluation | undefined>;
  updateEvaluation(
    workspaceId: string,
    id: string,
    patch: {
      status?: "active" | "terminal";
      terminalVerdict?: Verdict | null;
      currentIteration?: number;
      failedAngles?: string[];
      lastScore?: number | null;
      costCents?: number;
    },
  ): Promise<void>;
  listActiveEvaluations(workspaceId: string): Promise<VentureEvaluation[]>;
}

/**
 * Dollar-ceiling seam (#96 hardening): charge an evaluation's cost against the existing #71 tenant
 * usage accounting and read the accrued spend, so an evaluation that exhausts the tenant budget
 * terminates — the same accounting + cap that stops over-budget session launches.
 */
export interface UsageMeter {
  /** Accrued estimated cost (cents) for the tenant's current window. */
  spentCents(workspaceId: string, now: Date): Promise<number>;
  /** Charge one scoring pass's estimated cost to the tenant's current window. */
  charge(workspaceId: string, costCents: number, now: Date): Promise<void>;
}

/** #96 step 2 RESEARCH: gather evidence for an idea (web/#15 memory). Stubbed in `default.ts`. */
export interface EvidenceGatherer {
  gather(idea: VentureIdea): Promise<Evidence[]>;
}

/** #96 step 3 SCORE: the two independent personas (#59 path). Deterministic fake in tests. */
export interface PersonaScorer {
  score(
    idea: VentureIdea,
    evidence: Evidence[],
  ): Promise<{ advocate: PersonaScorecard; reviewer: PersonaScorecard }>;
}

/** #13 escalation: enqueue a borderline idea for human judgment. */
export interface ApprovalEnqueuer {
  enqueue(input: {
    workspaceId: string;
    ideaId: string;
    score: number;
    reasoning: string;
    createdByMemberId: string;
  }): Promise<{ id: string }>;
}

/** #15 memory: record a KILL verdict so the angle is never blindly retried. */
export interface MemoryRecorder {
  record(input: {
    workspaceId: string;
    ideaId: string;
    verdict: Verdict;
    reasoning: string;
    createdByMemberId: string | null;
  }): Promise<{ id: string }>;
}

/** #14 epic: emit the build epic when an idea is FUNDed (unlocks autonomy budget). */
export interface EpicEmitter {
  emit(input: {
    workspaceId: string;
    idea: VentureIdea;
    createdByMemberId: string;
  }): Promise<{ id: string }>;
}

/**
 * #146 constitution evidence: the demand-derived facts a decision is scored against, gathered behind one
 * seam so the pure checks stay pure. All from the #101 demand rails (externally-attributed only).
 */
export interface ConstitutionEvidence {
  /** Distinct unaffiliated (externally-attributed) paying-intent signals for the idea (Article I). */
  unaffiliatedPayingIntentSignals: number;
  /** Whether ANY externally-attributed demand evidence exists (Article V). */
  externalDemandPresent: boolean;
  /** Whether a realized `paid` signal exists (Article VIII). */
  paidSignalPresent: boolean;
}

/**
 * #146 constitution guard: the optional seam that scores a SOURCE/FUND/KILL decision against the YC
 * Startup Constitution. Default absent ⇒ the loop is byte-for-byte today's. The ONE verdict-changing
 * check (Article I love-gate) downgrades FUND → ESCALATE (a human-routed flag, never a silent fund);
 * every other check is flag-only. `record` persists the violations, surfaces them to the owner, and
 * feeds the flywheel — it never mutates the decision.
 */
export interface ConstitutionGuard {
  enabled(workspaceId: string): boolean;
  caps(workspaceId: string): ConstitutionCaps;
  evidenceFor(workspaceId: string, ideaId: string): Promise<ConstitutionEvidence>;
  record(input: {
    workspaceId: string;
    ideaId: string;
    stage: DecisionStage;
    /** The verdict under consideration (or the stage name at SOURCE). */
    verdict: string;
    violations: ConstitutionViolation[];
  }): Promise<void>;
}

export interface VentureServiceDeps {
  repo: VentureRepo;
  evidence: EvidenceGatherer;
  scorer: PersonaScorer;
  approvals: ApprovalEnqueuer;
  memory: MemoryRecorder;
  epics: EpicEmitter;
  /**
   * #146 constitution enforcement. Default absent ⇒ no decision is scored or gated (default-OFF). When
   * present and enabled, every SOURCE/FUND/KILL decision is scored; the Article I love-gate can downgrade
   * a B2B FUND → ESCALATE.
   */
  constitution?: ConstitutionGuard;
  /** Per-workspace resolved venture policy (thresholds, reviewer weight, scorecard TTL, cost). */
  caps: (workspaceId: string) => VentureCaps;
  /** Dollar-ceiling meter (#71 tenant usage). Default: a no-op meter (cost 0, never bites). */
  usage?: UsageMeter;
  /** The tenant's dollar budget cap in cents (the #71 scale budget). Default: 0 = no budget. */
  scaleBudgetCents?: (workspaceId: string) => number;
  /** The #17 kill switch for the workspace. Default: never engaged. */
  killSwitch?: (workspaceId: string) => Promise<boolean>;
  /**
   * #101 demand overlay: the externally-attributed willingness-to-pay evidence an idea has earned from a
   * fake-door smoke test. When present and non-empty, the demand dimension's synthetic persona score is
   * REPLACED by the real external score. Default: absent → the scorecard is unchanged (default-OFF). The
   * seam returns the branded `ExternalDemandEvidence`, so self-generated (circular) evidence can never
   * reach a demand dimension.
   */
  demand?: DemandEvidenceSource;
  /**
   * #114 customer-voice overlay: the post-launch customer voice an idea has earned (support tickets,
   * cancellations, NPS). When present and non-empty, the `problemSeverity` dimension's synthetic persona
   * score is REPLACED by the real voice score (real users reacting to a shipped product is the most honest
   * evidence the problem is acute). Default: absent → the scorecard is unchanged (default-OFF). Composes
   * with the #101 demand overlay (different dimension), so both can apply independently.
   */
  voice?: VoiceEvidenceSource;
  now?: () => Date;
}

/** One tick of an evaluation's loop. */
export interface AdvanceResult {
  /** The verdict applied this tick, or null when the tick was skipped (kill switch). */
  verdict: Verdict | null;
  /** True once the evaluation has reached a terminal verdict (FUND/KILL/ESCALATE). */
  terminal: boolean;
  /** True when this tick actually scored+decided (false when skipped or already terminal). */
  advanced: boolean;
  /** Why a tick was skipped, when it was. */
  skipped?: "kill_switch" | "already_terminal";
  /** True when the evaluation terminated because the dollar budget was exhausted (→ 402 semantics). */
  budgetExhausted?: boolean;
}

/** Thrown when an idea (or its prerequisite scorecard) does not exist — the route maps it to 404. */
export class VentureNotFoundError extends Error {
  constructor(message = "venture idea not found") {
    super(message);
    this.name = "VentureNotFoundError";
  }
}

export interface VentureView {
  idea: VentureIdea;
  latestScorecard: Scorecard | null;
  iterations: IterationLogEntry[];
}

export interface DecideResult {
  verdict: Verdict;
  reasoning: string;
  scorecard: Scorecard;
}

export class VentureService {
  constructor(private readonly deps: VentureServiceDeps) {}

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

  /** #96 step 1 SOURCE: persist the typed intake artifact + open its durable evaluation (so the tick
   * picks it up and advances it autonomously, not only on human-triggered route calls). */
  async submit(
    workspaceId: string,
    input: IdeaInput,
    createdByMemberId: string,
  ): Promise<VentureIdea> {
    const idea = await this.deps.repo.createIdea({ ...input, workspaceId, createdByMemberId });
    await this.deps.repo.getOrCreateEvaluation(workspaceId, idea.id);
    // #146 SOURCE-stage constitution scoring (flag-only — never blocks intake).
    await this.scoreConstitutionAtSource(workspaceId, idea);
    return idea;
  }

  /** #96 steps 2–3: gather evidence, score with both personas, persist a (verdict-less) scorecard. */
  async score(workspaceId: string, ideaId: string): Promise<Scorecard> {
    const idea = await this.deps.repo.getIdea(workspaceId, ideaId);
    if (!idea) throw new VentureNotFoundError();
    await this.deps.repo.updateIdeaStatus(workspaceId, ideaId, "scoring");

    const evidence = await this.deps.evidence.gather(idea);
    const { advocate, reviewer } = await this.deps.scorer.score(idea, evidence);
    const caps = this.deps.caps(workspaceId);

    // Compose the evidence overlays onto the combined dual-persona scorecard. Each overlay REPLACES only
    // the one dimension it owns with real, externally-attributed evidence when present; with neither the
    // score is byte-for-byte the plain dual-persona aggregate (default-OFF), and with only demand it is
    // byte-for-byte the prior #101 behaviour.
    // #101: real willingness-to-pay evidence from the idea's fake-door smoke test (replaces the circular
    // synthetic demand dimension).
    const demandEvidence = this.deps.demand
      ? await this.deps.demand.externalDemandEvidence(workspaceId, ideaId)
      : [];
    const demandScore = demandEvidence.length ? demandScoreFromExternal(demandEvidence) : null;
    // #114: real post-launch customer voice (replaces the synthetic problemSeverity dimension).
    const voiceEvidence = this.deps.voice
      ? await this.deps.voice.userVoiceEvidence(workspaceId, ideaId)
      : [];
    const voiceScore = voiceEvidence.length ? voiceDimensionScore(voiceEvidence) : null;

    let combined = combineDimensions(advocate, reviewer, caps.reviewerWeight);
    if (demandScore !== null) combined = overlayDemandDimension(combined, demandScore);
    if (voiceScore !== null) combined = overlayVoiceDimension(combined, voiceScore);
    const score = scorecardMeanScore(combined);

    const prev = await this.deps.repo.latestScorecard(workspaceId, ideaId);
    const iteration = (prev?.iteration ?? 0) + 1;
    const expiresAt = new Date(this.now().getTime() + caps.scorecardTtlMinutes * 60_000);

    const overlays: string[] = [];
    if (demandScore !== null) overlays.push(`demand dimension replaced by ${demandEvidence.length} external signal(s)`);
    if (voiceScore !== null) overlays.push(`problemSeverity replaced by ${voiceEvidence.length} customer-voice signal(s)`);
    const reasoning =
      overlays.length === 0
        ? `combined advocate+reviewer (reviewerWeight ${caps.reviewerWeight}) → ${score}`
        : `combined advocate+reviewer (reviewerWeight ${caps.reviewerWeight}); ${overlays.join("; ")} → ${score}`;

    return this.deps.repo.insertScorecard({
      workspaceId,
      ideaId,
      iteration,
      score,
      advocate,
      reviewer,
      reasoning,
      expiresAt,
    });
  }

  /** #96 step 4 DECIDE: run the pure gate on the latest scorecard, persist the log + durable loop
   * cursor, apply effects. `budgetExhausted` is set by the tick (`advance`) when the dollar ceiling
   * is hit; a human-triggered decide passes false. */
  async decide(
    workspaceId: string,
    ideaId: string,
    opts: { budgetExhausted?: boolean } = {},
  ): Promise<DecideResult> {
    const idea = await this.deps.repo.getIdea(workspaceId, ideaId);
    if (!idea) throw new VentureNotFoundError();
    const sc = await this.deps.repo.latestScorecard(workspaceId, ideaId);
    if (!sc) throw new VentureNotFoundError("no scorecard to decide — score the idea first");

    const caps = this.deps.caps(workspaceId);
    const thresholds = ventureThresholds(caps);

    // Durable loop cursor: the angles already tried+failed live on the evaluation row, so the
    // no-repeat check survives a crash/restart (not reconstructed from in-memory state).
    const evaluation = await this.deps.repo.getOrCreateEvaluation(workspaceId, ideaId);
    const failedAngles = evaluation.failedAngles;
    const proposedAngles = gapAngles(sc.advocate, sc.reviewer, caps.reviewerWeight);

    const decision = decideVenture({
      score: sc.score,
      iteration: sc.iteration,
      proposedAngles,
      failedAngles,
      budgetExhausted: opts.budgetExhausted ?? false,
      thresholds,
    });

    // #146 constitution overlay: score the decision against the Articles and (for the Article I
    // love-gate only) downgrade the verdict. The final verdict drives every write below.
    const { verdict, reasoning } = await this.applyConstitutionAtDecide(
      workspaceId,
      idea,
      decision.verdict,
      decision.reasoning,
    );

    const evidence = await this.deps.evidence.gather(idea);
    const gapList: GapList = {
      gaps: proposedAngles.map((d) => ({ dimension: d, note: `strengthen ${d}` })),
    };
    await this.deps.repo.insertIteration({
      workspaceId,
      ideaId,
      iteration: sc.iteration,
      score: sc.score,
      verdict,
      gapList,
      angles: proposedAngles,
      evidence,
      workingMemorySummary: reasoning,
    });
    await this.deps.repo.setScorecardVerdict(workspaceId, sc.id, verdict, verdict === "FUND");
    await this.persistEvaluationProgress(
      workspaceId,
      evaluation,
      sc,
      verdict,
      proposedAngles,
      failedAngles,
    );
    await this.applyVerdict(workspaceId, idea, sc.score, verdict, reasoning);

    return {
      verdict,
      reasoning,
      scorecard: { ...sc, verdict, funded: verdict === "FUND" },
    };
  }

  /**
   * One tick of an idea's evaluation (#96 hardening — infrastructure time). Resumes from the durable
   * cursor, is gated by the #17 kill switch, and charges the dollar ceiling: if the tenant budget is
   * already spent it terminates ESCALATE without scoring (402 semantics); otherwise it charges one
   * pass, scores, and decides (forcing ESCALATE if that charge tipped the tenant over budget).
   */
  async advance(workspaceId: string, ideaId: string): Promise<AdvanceResult> {
    const idea = await this.deps.repo.getIdea(workspaceId, ideaId);
    if (!idea) throw new VentureNotFoundError();
    const evaluation = await this.deps.repo.getOrCreateEvaluation(workspaceId, ideaId);
    if (evaluation.status === "terminal") {
      return {
        verdict: evaluation.terminalVerdict,
        terminal: true,
        advanced: false,
        skipped: "already_terminal",
      };
    }
    if (await this.killSwitchEngaged(workspaceId)) {
      return { verdict: null, terminal: false, advanced: false, skipped: "kill_switch" };
    }

    const now = this.now();
    const caps = this.deps.caps(workspaceId);
    const budget = this.budgetCents(workspaceId);

    const spentBefore = await this.usage.spentCents(workspaceId, now);
    if (budgetExceeded(spentBefore, budget)) {
      await this.terminateBudgetExhausted(workspaceId, idea, evaluation);
      return { verdict: "ESCALATE", terminal: true, advanced: false, budgetExhausted: true };
    }

    await this.usage.charge(workspaceId, caps.evaluationCostCents, now);
    await this.score(workspaceId, ideaId);
    const spentAfter = await this.usage.spentCents(workspaceId, now);
    const budgetExhausted = budgetExceeded(spentAfter, budget);
    const decision = await this.decide(workspaceId, ideaId, { budgetExhausted });
    // Accrue the charged cost onto the durable evaluation (decide already wrote the loop cursor).
    const fresh = await this.deps.repo.getEvaluation(workspaceId, ideaId);
    await this.deps.repo.updateEvaluation(workspaceId, evaluation.id, {
      costCents: (fresh?.costCents ?? evaluation.costCents) + caps.evaluationCostCents,
    });

    return {
      verdict: decision.verdict,
      terminal: decision.verdict !== "ITERATE",
      advanced: true,
      budgetExhausted,
    };
  }

  /** One scheduled tick over a workspace's active evaluations (gated by the kill switch). */
  async tick(workspaceId: string): Promise<AdvanceResult[]> {
    if (await this.killSwitchEngaged(workspaceId)) return [];
    const active = await this.deps.repo.listActiveEvaluations(workspaceId);
    const results: AdvanceResult[] = [];
    for (const ev of active) {
      try {
        results.push(await this.advance(workspaceId, ev.ideaId));
      } catch {
        // A single evaluation's failure must not stop the tick from advancing the others.
      }
    }
    return results;
  }

  /** The full loop driven to a terminal verdict via repeated ticks (human-triggered convenience). */
  async runLoop(
    workspaceId: string,
    ideaId: string,
    _createdByMemberId?: string,
  ): Promise<{ verdict: Verdict; iterations: number }> {
    const caps = this.deps.caps(workspaceId);
    const hardStop = caps.maxIterations + 3;
    let guard = 0;
    for (;;) {
      const r = await this.advance(workspaceId, ideaId);
      if (r.terminal || r.skipped || ++guard > hardStop) break;
    }
    const evaluation = await this.deps.repo.getEvaluation(workspaceId, ideaId);
    return {
      verdict: evaluation?.terminalVerdict ?? "ESCALATE",
      iterations: evaluation?.currentIteration ?? 0,
    };
  }

  /**
   * Activation kickoff (#230). An owner who activates their workspace has *chosen* to build their
   * founding venture — that human choice IS the funding decision, and it is deliberately distinct from
   * the #96 autonomous scoring gate (which exists to stop the fleet from auto-funding unvalidated
   * AI-generated ideas, and is left completely unchanged here). So activation: scores the venture once
   * for the honest record (a real, possibly-low scorecard + one logged iteration), then funds it by
   * owner activation — emitting the build epic and setting `epicTaskId` — so an activated workspace
   * always has a funded venture with real work to pick up, never an inert `intake` row that the console
   * sits on forever ("clocking in"). Crucially it does NOT mark the scorecard `funded`, so
   * `hasPassingUnexpiredScorecard` stays false and the autonomy admission gate is NOT weakened: an
   * unvalidated idea still cannot auto-launch fleet sessions. Idempotent: a venture that already has an
   * epic is returned unchanged (no re-score, no duplicate epic), so a re-seed / boot backfill is safe.
   */
  async kickoffFounding(
    workspaceId: string,
    ideaId: string,
    _createdByMemberId?: string,
  ): Promise<{ epicTaskId: string | null; score: number | null; iterations: number; verdict: Verdict }> {
    const idea = await this.deps.repo.getIdea(workspaceId, ideaId);
    if (!idea) throw new VentureNotFoundError();

    // Idempotent: an activated founding venture already has its epic — never re-score or re-emit.
    if (idea.epicTaskId) {
      const sc = await this.deps.repo.latestScorecard(workspaceId, ideaId);
      const its = await this.deps.repo.listIterations(workspaceId, ideaId);
      return { epicTaskId: idea.epicTaskId, score: sc?.score ?? null, iterations: its.length, verdict: "FUND" };
    }

    // Score once for the honest record (a real scorecard; it may be low — that's fine, scoring is not
    // a gate at activation, it is provenance the founder can see).
    const scorecard = await this.score(workspaceId, ideaId);
    const evaluation = await this.deps.repo.getOrCreateEvaluation(workspaceId, ideaId);
    const reasoning =
      `Funded by owner activation (#230): the owner chose to build this founding venture. ` +
      `Scored ${scorecard.score} for the record; the #96 autonomous scoring gate is unchanged and ` +
      `still governs fleet auto-launches.`;

    // Log the activation decision as an iteration so the founder sees it (guarantees iterations ≥ 1).
    await this.deps.repo.insertIteration({
      workspaceId,
      ideaId,
      iteration: scorecard.iteration,
      score: scorecard.score,
      verdict: "FUND",
      gapList: { gaps: [] },
      angles: [],
      evidence: await this.deps.evidence.gather(idea),
      workingMemorySummary: reasoning,
    });
    await this.deps.repo.updateEvaluation(workspaceId, evaluation.id, {
      status: "terminal",
      terminalVerdict: "FUND",
      currentIteration: scorecard.iteration,
      lastScore: scorecard.score,
    });
    // Apply the FUND side effects: status funded + emit the build epic (+ first tasks) + setIdeaEpic.
    // We intentionally do NOT call setScorecardVerdict(…, funded=true) — the admission gate stays closed.
    await this.applyVerdict(workspaceId, idea, scorecard.score, "FUND", reasoning);

    const updated = await this.deps.repo.getIdea(workspaceId, ideaId);
    const its = await this.deps.repo.listIterations(workspaceId, ideaId);
    return {
      epicTaskId: updated?.epicTaskId ?? null,
      score: scorecard.score,
      iterations: its.length,
      verdict: "FUND",
    };
  }

  /** Read a full venture view: the idea, its latest scorecard, and the iteration log. */
  async get(workspaceId: string, ideaId: string): Promise<VentureView> {
    const idea = await this.deps.repo.getIdea(workspaceId, ideaId);
    if (!idea) throw new VentureNotFoundError();
    const latestScorecard = (await this.deps.repo.latestScorecard(workspaceId, ideaId)) ?? null;
    const iterations = await this.deps.repo.listIterations(workspaceId, ideaId);
    return { idea, latestScorecard, iterations };
  }

  /**
   * #146 SOURCE-stage constitution scoring. Flag-only — records any early-warning violations (e.g. a
   * B2B idea sourced with no demand evidence yet) but never blocks intake. No-op when the guard is
   * absent or disabled (default-OFF).
   */
  private async scoreConstitutionAtSource(workspaceId: string, idea: VentureIdea): Promise<void> {
    const guard = this.deps.constitution;
    if (!guard || !guard.enabled(workspaceId)) return;
    const caps = guard.caps(workspaceId);
    const ev = await guard.evidenceFor(workspaceId, idea.id);
    const { violations } = scoreDecision(
      {
        stage: "SOURCE",
        segment: idea.segment,
        unaffiliatedPayingIntentSignals: ev.unaffiliatedPayingIntentSignals,
        externalDemandPresent: ev.externalDemandPresent,
        paidSignalPresent: ev.paidSignalPresent,
      },
      caps,
    );
    if (violations.length > 0) {
      await guard.record({ workspaceId, ideaId: idea.id, stage: "SOURCE", verdict: "SOURCE", violations });
    }
  }

  /**
   * #146 FUND/KILL-stage constitution overlay. Runs the Article I love-gate (the ONLY check that
   * changes a verdict — downgrades a B2B FUND lacking love evidence to ESCALATE, routing it to a
   * human) and the deterministic scorer (flag-only), records the violations, and returns the final
   * verdict + reasoning. No-op (returns the base verdict unchanged) when the guard is absent/disabled
   * or the verdict is not a FUND/KILL decision.
   */
  private async applyConstitutionAtDecide(
    workspaceId: string,
    idea: VentureIdea,
    baseVerdict: Verdict,
    baseReasoning: string,
  ): Promise<{ verdict: Verdict; reasoning: string }> {
    const guard = this.deps.constitution;
    if (!guard || !guard.enabled(workspaceId)) return { verdict: baseVerdict, reasoning: baseReasoning };
    const stage: DecisionStage | null =
      baseVerdict === "FUND" ? "FUND" : baseVerdict === "KILL" ? "KILL" : null;
    if (!stage) return { verdict: baseVerdict, reasoning: baseReasoning };

    const caps = guard.caps(workspaceId);
    const ev = await guard.evidenceFor(workspaceId, idea.id);

    const love = evaluateLoveGate({
      enabled: caps.enabled,
      verdict: baseVerdict,
      segment: idea.segment,
      unaffiliatedPayingIntentSignals: ev.unaffiliatedPayingIntentSignals,
      minSignals: caps.loveMinSignals,
      stage: "FUND",
    });
    const finalVerdict: Verdict = love.gated ? "ESCALATE" : baseVerdict;

    const { violations } = scoreDecision(
      {
        stage,
        segment: idea.segment,
        unaffiliatedPayingIntentSignals: ev.unaffiliatedPayingIntentSignals,
        externalDemandPresent: ev.externalDemandPresent,
        paidSignalPresent: ev.paidSignalPresent,
      },
      caps,
    );
    if (violations.length > 0) {
      await guard.record({ workspaceId, ideaId: idea.id, stage, verdict: baseVerdict, violations });
    }

    const reasoning = love.gated
      ? `${baseReasoning} — Article I love-paradigm gate: a B2B venture cannot FUND without ` +
        `≥${caps.loveMinSignals} unaffiliated paying-intent signals (found ` +
        `${ev.unaffiliatedPayingIntentSignals}); escalating to a human instead of funding`
      : baseReasoning;

    return { verdict: finalVerdict, reasoning };
  }

  /** Persist the durable loop cursor after a decision: advance + remember failed angles on ITERATE,
   * or stamp the terminal verdict so a later tick/restart never re-runs a finished evaluation. */
  private async persistEvaluationProgress(
    workspaceId: string,
    evaluation: VentureEvaluation,
    sc: Scorecard,
    verdict: Verdict,
    proposedAngles: string[],
    failedAngles: string[],
  ): Promise<void> {
    if (verdict === "ITERATE") {
      await this.deps.repo.updateEvaluation(workspaceId, evaluation.id, {
        status: "active",
        currentIteration: sc.iteration,
        failedAngles: [...new Set([...failedAngles, ...proposedAngles])],
        lastScore: sc.score,
      });
    } else {
      await this.deps.repo.updateEvaluation(workspaceId, evaluation.id, {
        status: "terminal",
        terminalVerdict: verdict,
        currentIteration: sc.iteration,
        lastScore: sc.score,
      });
    }
  }

  /** Terminate ESCALATE because the dollar ceiling was already spent — no scoring this pass. */
  private async terminateBudgetExhausted(
    workspaceId: string,
    idea: VentureIdea,
    evaluation: VentureEvaluation,
  ): Promise<void> {
    const reasoning = "dollar budget exhausted before this pass — escalating to a human";
    const score = evaluation.lastScore ?? 0;
    const iteration = evaluation.currentIteration + 1;
    await this.deps.repo.insertIteration({
      workspaceId,
      ideaId: idea.id,
      iteration,
      score,
      verdict: "ESCALATE",
      gapList: { gaps: [] },
      angles: [],
      evidence: [],
      workingMemorySummary: reasoning,
    });
    await this.deps.repo.updateEvaluation(workspaceId, evaluation.id, {
      status: "terminal",
      terminalVerdict: "ESCALATE",
      currentIteration: iteration,
    });
    await this.applyVerdict(workspaceId, idea, score, "ESCALATE", reasoning);
  }

  /** Apply the verdict's side effects (the loop's act stage). */
  private async applyVerdict(
    workspaceId: string,
    idea: VentureIdea,
    score: number,
    verdict: Verdict,
    reasoning: string,
  ): Promise<void> {
    const creator = idea.createdByMemberId;
    switch (verdict) {
      case "FUND": {
        await this.deps.repo.updateIdeaStatus(workspaceId, idea.id, "funded");
        if (creator) {
          const epic = await this.deps.epics.emit({ workspaceId, idea, createdByMemberId: creator });
          await this.deps.repo.setIdeaEpic(workspaceId, idea.id, epic.id);
        }
        return;
      }
      case "KILL": {
        await this.deps.repo.updateIdeaStatus(workspaceId, idea.id, "killed");
        await this.deps.memory.record({
          workspaceId,
          ideaId: idea.id,
          verdict,
          reasoning,
          createdByMemberId: creator,
        });
        return;
      }
      case "ESCALATE": {
        await this.deps.repo.updateIdeaStatus(workspaceId, idea.id, "escalated");
        if (creator) {
          await this.deps.approvals.enqueue({
            workspaceId,
            ideaId: idea.id,
            score,
            reasoning,
            createdByMemberId: creator,
          });
        }
        return;
      }
      case "ITERATE": {
        await this.deps.repo.updateIdeaStatus(workspaceId, idea.id, "iterating");
        return;
      }
    }
  }
}
