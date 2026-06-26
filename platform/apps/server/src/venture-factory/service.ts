import type { ApprovalStatus } from "../approvals/policy.js";
import {
  VENTURE_BOOTSTRAP_ACTION,
} from "../approvals/policy.js";
import type { VentureFactoryCaps } from "./caps.js";
import { decideEdgeGate, decideFactoryAdmission } from "./edge-gate.js";
import { scoreCandidate } from "./scanner.js";
import {
  decideValidationOutcome,
  decideValidationSpend,
  scoreFromReceipts,
} from "./validation.js";
import {
  autonomousSteps,
  moneySteps,
  planBootstrap,
} from "./bootstrap.js";
import type {
  BootstrapStepKind,
  CandidateEvidence,
  CandidateRecord,
  CandidateSourceKind,
  EdgeClaim,
  FactoryVenture,
  ValidationReceipt,
} from "./types.js";

/**
 * The Venture Factory IO orchestrator (#187, ADR-0187). Declares one seam per collaborator (the
 * candidate/validation/venture stores, the #13 gate, the #17 kill switch, the #71 budget, the #138 fleet
 * seeder, the smoke-test publisher, the external-profitability reader, the venture archiver); the pure
 * decision math lives in `edge-gate`/`scanner`/`validation`/`bootstrap`. So the service runs against
 * fakes in tests and the real repos/services in `default.ts`.
 *
 * The factory answers to the premortem (#200) at every seam:
 *   - **FM#1 edge gate**: `validate` runs `decideEdgeGate` FIRST — an un-edged candidate is killed, never
 *     validated. `bootstrap` runs `decideFactoryAdmission` — no new venture while one is unprofitable.
 *   - **FM#2 external receipts**: the validation scorecard is built only from ingested external receipts.
 *   - **FM#4/#1055 spend safety**: MONEY bootstrap steps reserve spend against the hard cap before they
 *     run; only cap raises queue for the owner.
 */

const MAX_SCORE = 100;
const AGENT_DELIVERABLE_ACTION = "agent.deliverable";

export interface FactoryApprovalGate {
  /** Whether `actionKind` needs a human for this workspace (the #13 policy). */
  requiresApproval(workspaceId: string, actionKind: string): Promise<boolean>;
  /** Open a (sensitive-by-default) #13 request under `actionKind`; returns its id. */
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    actionKind: string;
    summary: string;
    amountCents?: number | null;
    payload: Record<string, unknown>;
  }): Promise<{ id: string }>;
  /** Read a request's current status. */
  status(approvalRequestId: string): Promise<ApprovalStatus | undefined>;
}

/** The #17 kill switch — when tripped, no autonomous factory step runs. */
export interface FactoryKillSwitch {
  isTripped(workspaceId: string): Promise<boolean>;
}

/** The #71 dollar ceiling — charge tenant usage; throws/returns false when the ceiling is hit. */
export interface FactoryBudget {
  /** Charge `cents` for an autonomous pass; returns false when the dollar ceiling is exceeded. */
  charge(workspaceId: string, cents: number, reason: string): Promise<boolean>;
}

/** The #138 fleet seeder — stands up the seven-department fleet for a new venture workspace (idempotent). */
export interface FleetSeeder {
  seed(input: { workspaceId: string; createdByMemberId: string }): Promise<void>;
}

/**
 * Provisions a venture's deploy target at bootstrap (#195) — the Fly/Vercel project + envs + SSL +
 * preview & prod URLs. Optional and idempotent: default-OFF / unwired ⇒ the reversible `repo_deploy_target`
 * step stays the no-op it was, and a re-run never provisions twice (the provisioner short-circuits on an
 * existing target). Infra spend is checked against the venture's budget cap inside the provisioner.
 */
export interface DeployTargetProvisioner {
  provision(input: {
    workspaceId: string;
    ventureId: string;
    ventureName: string;
    createdByMemberId: string;
  }): Promise<void>;
}

/** Ships the smoke-test landing + waitlist via the #153 marketing-site patterns (an external.send, #13). */
export interface SmokeTestPublisher {
  publish(input: {
    workspaceId: string;
    candidateId: string;
    ventureName: string;
    requesterMemberId: string;
  }): Promise<{ approvalRequestId: string | null }>;
}

/** Reads EXTERNAL profitability (revenue > cost, externally verified) for the scaling gate (FM#1/FM#2). */
export interface ProfitabilityReader {
  /** How many active ventures have an EXTERNAL profitability receipt. */
  externallyProfitableCount(workspaceId: string): Promise<number>;
}

/** Tears a venture down cleanly on a sunset (cancel schedules, retain artifacts) — reuses #107. */
export interface VentureArchiver {
  archive(input: { workspaceId: string; factoryVentureId: string; candidateId: string }): Promise<void>;
}

/** The candidate/validation/venture persistence seams (the real impls bind `db/repositories/venture-factory`). */
export interface FactoryStore {
  insertCandidate(input: {
    workspaceId: string;
    source: CandidateSourceKind;
    thesis: string;
    proposedName: string;
    painIntensity: number;
    competitionAbsence: number;
    observedAt: Date;
    citations: string[];
    score: number;
    edgeClaims: EdgeClaim[];
    createdByMemberId: string | null;
  }): Promise<CandidateRecord>;
  getCandidate(workspaceId: string, id: string): Promise<CandidateRecord | undefined>;
  listCandidatesByStatus(
    workspaceId: string,
    status: CandidateRecord["status"],
    limit?: number,
  ): Promise<CandidateRecord[]>;
  setCandidate(
    workspaceId: string,
    id: string,
    patch: { status?: CandidateRecord["status"]; edgeStatus?: CandidateRecord["edgeStatus"] },
  ): Promise<CandidateRecord | undefined>;
  ensureValidation(input: {
    workspaceId: string;
    candidateId: string;
    budgetCapCents: number;
  }): Promise<import("./types.js").ValidationRecord>;
  getValidationByCandidate(
    workspaceId: string,
    candidateId: string,
  ): Promise<import("./types.js").ValidationRecord | undefined>;
  updateValidation(
    workspaceId: string,
    id: string,
    patch: Partial<{
      spentCents: number;
      signups: number;
      cacCents: number | null;
      score: number;
      verdict: import("./types.js").ValidationVerdict | null;
      status: "running" | "concluded";
      receipts: ValidationReceipt[];
    }>,
  ): Promise<import("./types.js").ValidationRecord | undefined>;
  ensureVenture(input: {
    workspaceId: string;
    candidateId: string;
    name: string;
    approvalRequestId: string | null;
  }): Promise<FactoryVenture>;
  getVentureByCandidate(workspaceId: string, candidateId: string): Promise<FactoryVenture | undefined>;
  setVenture(
    workspaceId: string,
    id: string,
    patch: { status?: FactoryVenture["status"]; ventureIdeaId?: string | null; archivedAt?: Date | null },
  ): Promise<FactoryVenture | undefined>;
  countActiveVentures(workspaceId: string): Promise<number>;
}

export interface VentureFactoryDeps {
  store: FactoryStore;
  gate: FactoryApprovalGate;
  killSwitch: FactoryKillSwitch;
  budget: FactoryBudget;
  fleet: FleetSeeder;
  /** Provisions the per-venture deploy target on the `repo_deploy_target` step (#195). Optional ⇒ no-op. */
  deploy?: DeployTargetProvisioner;
  smokeTest: SmokeTestPublisher;
  profitability: ProfitabilityReader;
  archiver: VentureArchiver;
  /** The workspace owner (for `ownerWorkspaceOnly`); null when unknown. */
  ownerWorkspaceId?: (workspaceId: string) => Promise<string | null>;
  caps: (workspaceId: string) => VentureFactoryCaps;
  now?: () => Date;
}

export class VentureFactoryDisabledError extends Error {
  constructor(reason: string) {
    super(`venture factory step refused: ${reason}`);
    this.name = "VentureFactoryDisabledError";
  }
}

export class CandidateNotFoundError extends Error {
  constructor(id: string) {
    super(`venture-factory candidate not found: ${id}`);
    this.name = "CandidateNotFoundError";
  }
}

/** One raw opportunity signal a lens/scout files for scoring. */
export interface ScanInput {
  source: CandidateSourceKind;
  thesis: string;
  proposedName: string;
  evidence: CandidateEvidence;
  edgeClaims: EdgeClaim[];
  createdByMemberId: string | null;
}

export interface ExternalPaidOpportunityInput {
  title: string;
  sourceUrl: string;
  buyer?: string;
  compensation?: string;
  description?: string;
  observedAt?: Date;
  createdByMemberId: string | null;
}

export interface BootstrapResult {
  venture: FactoryVenture;
  /** The steps that ran autonomously, including MONEY steps whose spend fit inside the hard cap. */
  ranSteps: BootstrapStepKind[];
  /** MONEY steps blocked on a human-approved cap raise (each with its approval id). */
  moneyDecisions: Array<{ kind: BootstrapStepKind; approvalRequestId: string }>;
}

export interface OpportunityDeliveryResult {
  approvalRequestId: string;
  actionKind: typeof AGENT_DELIVERABLE_ACTION;
}

export class VentureFactoryService {
  private readonly deps: VentureFactoryDeps;
  private readonly now: () => Date;

  constructor(deps: VentureFactoryDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Ingest one real external paid opportunity as sandboxed DATA (#1060). This is user/authenticated intake,
   * not autonomous spend or sending, so it does not require the scanner loop to be enabled. Every string is
   * bounded and control-character stripped before persistence; the source URL is stored only as citation /
   * evidence, never executed. The resulting factory candidate is the structured in-product record later
   * validation/delivery steps consume.
   */
  async ingestExternalPaidOpportunity(
    workspaceId: string,
    input: ExternalPaidOpportunityInput,
  ): Promise<CandidateRecord> {
    const title = cleanOpportunityText(input.title, 160);
    const sourceUrl = cleanOpportunityText(input.sourceUrl, 500);
    if (!title) throw new VentureFactoryDisabledError("paid opportunity title is required");
    if (!isHttpUrl(sourceUrl)) {
      throw new VentureFactoryDisabledError("paid opportunity sourceUrl must be an http(s) URL");
    }

    const buyer = cleanOpportunityText(input.buyer ?? "external buyer", 120);
    const compensation = cleanOpportunityText(input.compensation ?? "paid opportunity", 120);
    const description = cleanOpportunityText(input.description ?? "", 500);
    const thesis = cleanOpportunityText(
      [title, buyer ? "buyer: " + buyer : "", compensation ? "compensation: " + compensation : ""]
        .filter(Boolean)
        .join(" | "),
      300,
    );

    return this.deps.store.insertCandidate({
      workspaceId,
      source: "scout",
      thesis,
      proposedName: title,
      painIntensity: 8,
      competitionAbsence: 6,
      observedAt: input.observedAt ?? this.now(),
      citations: [sourceUrl],
      score: scoreCandidate(
        {
          source: "scout",
          evidence: {
            painIntensity: 8,
            competitionAbsence: 6,
            observedAt: input.observedAt ?? this.now(),
            citations: [sourceUrl],
          },
        },
        this.now(),
        this.deps.caps(workspaceId).freshnessHalfLifeDays,
      ),
      edgeClaims: [
        {
          kind: "relationship",
          statement: "A real external buyer posted a paid opportunity for this work.",
          falsifiableTest:
            "Reject if the source URL no longer shows paid work or the buyer cannot confirm budget.",
          evidence: [
            {
              source: sourceUrl,
              external: true,
              ownerAttested: false,
              detail: cleanOpportunityText(
                description || title + " from " + buyer + " with " + compensation,
                300,
              ),
            },
          ],
        },
      ],
      createdByMemberId: input.createdByMemberId,
    });
  }

  /** Assert the factory may run an autonomous step in this workspace (enabled + owner-scope). */
  private async assertAutonomyAllowed(workspaceId: string, caps: VentureFactoryCaps): Promise<void> {
    if (!caps.enabled) throw new VentureFactoryDisabledError("ventureFactory.enabled is false");
    if (caps.ownerWorkspaceOnly && this.deps.ownerWorkspaceId) {
      const owner = await this.deps.ownerWorkspaceId(workspaceId);
      if (owner !== null && owner !== workspaceId) {
        throw new VentureFactoryDisabledError("ownerWorkspaceOnly: not the owner workspace");
      }
    }
    if (await this.deps.killSwitch.isTripped(workspaceId)) {
      throw new VentureFactoryDisabledError("kill switch tripped");
    }
  }

  /**
   * Score and file a batch of lens/scout-surfaced candidates (#187 AC1). Gated by enabled/owner/kill
   * switch + a per-pass budget pre-charge (#71). Scoring is the pure `scoreCandidate`; the candidate is
   * persisted `scanned` with its evidence + edge claims for the validation stage. Returns what was filed.
   */
  async scan(workspaceId: string, inputs: ScanInput[]): Promise<CandidateRecord[]> {
    const caps = this.deps.caps(workspaceId);
    await this.assertAutonomyAllowed(workspaceId, caps);
    if (inputs.length === 0) return [];
    const ok = await this.deps.budget.charge(workspaceId, caps.scanCostCents, "venture-factory scan");
    if (!ok) throw new VentureFactoryDisabledError("scan budget ceiling reached");

    const now = this.now();
    const filed: CandidateRecord[] = [];
    for (const input of inputs) {
      const score = scoreCandidate(
        { source: input.source, evidence: input.evidence },
        now,
        caps.freshnessHalfLifeDays,
      );
      const candidate = await this.deps.store.insertCandidate({
        workspaceId,
        source: input.source,
        thesis: input.thesis,
        proposedName: input.proposedName,
        painIntensity: input.evidence.painIntensity,
        competitionAbsence: input.evidence.competitionAbsence,
        observedAt: input.evidence.observedAt,
        citations: input.evidence.citations,
        score,
        edgeClaims: input.edgeClaims,
        createdByMemberId: input.createdByMemberId,
      });
      filed.push(candidate);
    }
    return filed;
  }

  /**
   * Start validating a candidate (#187 AC2). The EDGE GATE runs FIRST (premortem FM#1): a candidate
   * whose edge claims do not qualify is marked `killed` and never validated — no smoke test, no spend.
   * A qualifying candidate has its edge recorded `qualified`, a validation experiment opened (with the
   * HARD budget cap from caps), the smoke-test landing published (an external.send → #13), and its status
   * moved to `validating`. Also gated by the candidate's score floor.
   */
  async validate(
    workspaceId: string,
    candidateId: string,
    opts: { requesterMemberId: string },
  ): Promise<{ edgeQualified: boolean; reason: string }> {
    const caps = this.deps.caps(workspaceId);
    await this.assertAutonomyAllowed(workspaceId, caps);
    const candidate = await this.requireCandidate(workspaceId, candidateId);

    if (candidate.score < caps.minScoreToValidate) {
      await this.deps.store.setCandidate(workspaceId, candidateId, { status: "killed" });
      return { edgeQualified: false, reason: `score ${candidate.score} < floor ${caps.minScoreToValidate}` };
    }

    const verdict = decideEdgeGate({ claims: candidate.edgeClaims });
    if (verdict.status !== "qualified") {
      await this.deps.store.setCandidate(workspaceId, candidateId, {
        edgeStatus: "rejected",
        status: "killed",
      });
      return { edgeQualified: false, reason: `edge gate rejected: ${verdict.reasons.join("; ")}` };
    }

    await this.deps.store.setCandidate(workspaceId, candidateId, {
      edgeStatus: "qualified",
      status: "validating",
    });
    await this.deps.store.ensureValidation({
      workspaceId,
      candidateId,
      budgetCapCents: caps.validationBudgetCapCents,
    });
    await this.deps.smokeTest.publish({
      workspaceId,
      candidateId,
      ventureName: candidate.proposedName,
      requesterMemberId: opts.requesterMemberId,
    });
    return { edgeQualified: true, reason: `edge qualified (${verdict.edgeClasses.join(", ")})` };
  }

  /**
   * Ingest EXTERNAL validation receipts (#187 AC2, premortem FM#2). An `ad_spend` receipt is checked
   * against the HARD budget cap (`decideValidationSpend`) — over-cap spend is rejected and dropped. The
   * scorecard (`scoreFromReceipts`) is rebuilt from the accumulated receipts and persisted; CAC/score are
   * UNVERIFIED estimates. Returns the new scorecard.
   */
  async ingestReceipts(
    workspaceId: string,
    candidateId: string,
    incoming: ValidationReceipt[],
  ): Promise<{ accepted: ValidationReceipt[]; rejected: ValidationReceipt[]; spentCents: number }> {
    const caps = this.deps.caps(workspaceId);
    const validation =
      (await this.deps.store.getValidationByCandidate(workspaceId, candidateId)) ??
      (await this.deps.store.ensureValidation({
        workspaceId,
        candidateId,
        budgetCapCents: caps.validationBudgetCapCents,
      }));

    const kept: ValidationReceipt[] = [...validation.receipts];
    const accepted: ValidationReceipt[] = [];
    const rejected: ValidationReceipt[] = [];
    let spent = validation.spentCents;

    for (const r of incoming) {
      if (r.kind === "ad_spend") {
        const decision = decideValidationSpend({
          budgetCapCents: validation.budgetCapCents,
          spentCents: spent,
          requestedCents: r.amountCents,
        });
        if (!decision.allowed) {
          rejected.push(r);
          continue;
        }
        spent += r.amountCents;
      }
      kept.push(r);
      accepted.push(r);
    }

    const card = scoreFromReceipts(kept, { pointsPerSignup: caps.pointsPerSignup });
    await this.deps.store.updateValidation(workspaceId, validation.id, {
      receipts: kept,
      spentCents: card.spentCents,
      signups: card.signups,
      cacCents: card.cacCents,
      score: Math.min(MAX_SCORE, card.score),
    });
    return { accepted, rejected, spentCents: card.spentCents };
  }

  /**
   * Conclude a validation experiment (#187 AC2). Reads the scorecard, decides PROMOTE/KILL/INCONCLUSIVE
   * (`decideValidationOutcome`), and routes:
   *   - PROMOTE → candidate `bootstrap_pending`; open the owner `venture.bootstrap` go/no-go (#13/AC3);
   *   - KILL    → candidate `killed`; validation `concluded`;
   *   - INCONCLUSIVE (budget exhausted) → escalate via #13 (a human decides); validation `concluded`.
   * Returns the verdict + any opened approval id.
   */
  async concludeValidation(
    workspaceId: string,
    candidateId: string,
    opts: { requesterMemberId: string },
  ): Promise<{ verdict: string; approvalRequestId: string | null; reasoning: string }> {
    const caps = this.deps.caps(workspaceId);
    await this.assertAutonomyAllowed(workspaceId, caps);
    const candidate = await this.requireCandidate(workspaceId, candidateId);
    const validation = await this.deps.store.getValidationByCandidate(workspaceId, candidateId);
    if (!validation) throw new VentureFactoryDisabledError(`no validation experiment for ${candidateId}`);

    const card = {
      signups: validation.signups,
      spentCents: validation.spentCents,
      cacCents: validation.cacCents,
      score: validation.score,
      estimateLabel: "UNVERIFIED" as const,
    };
    const budgetExhausted = validation.spentCents >= validation.budgetCapCents;
    const outcome = decideValidationOutcome({
      scorecard: card,
      budgetExhausted,
      thresholds: {
        minSignups: caps.minSignupsToPromote,
        maxCacCents: caps.maxCacCents,
        killSignups: caps.killSignups,
      },
    });

    if (outcome.verdict === "PROMOTE") {
      await this.deps.store.updateValidation(workspaceId, validation.id, {
        verdict: "PROMOTE",
        status: "concluded",
      });
      await this.deps.store.setCandidate(workspaceId, candidateId, { status: "bootstrap_pending" });
      const req = await this.deps.gate.submit({
        workspaceId,
        requesterMemberId: opts.requesterMemberId,
        actionKind: VENTURE_BOOTSTRAP_ACTION,
        summary: `Launch venture "${candidate.proposedName}": ${card.signups} external signups (CAC ${card.cacCents ?? "n/a"}¢)`,
        payload: { candidateId, signups: card.signups, cacCents: card.cacCents, edgeStatus: candidate.edgeStatus },
      });
      return { verdict: "PROMOTE", approvalRequestId: req.id, reasoning: outcome.reasoning };
    }

    if (outcome.verdict === "KILL") {
      await this.deps.store.updateValidation(workspaceId, validation.id, { verdict: "KILL", status: "concluded" });
      await this.deps.store.setCandidate(workspaceId, candidateId, { status: "killed" });
      return { verdict: "KILL", approvalRequestId: null, reasoning: outcome.reasoning };
    }

    // INCONCLUSIVE → escalate to a human (the EV decision is theirs).
    await this.deps.store.updateValidation(workspaceId, validation.id, {
      verdict: "INCONCLUSIVE",
      status: "concluded",
    });
    const req = await this.deps.gate.submit({
      workspaceId,
      requesterMemberId: opts.requesterMemberId,
      actionKind: VENTURE_BOOTSTRAP_ACTION,
      summary: `Inconclusive validation for "${candidate.proposedName}" — ${outcome.reasoning}`,
      payload: { candidateId, signups: card.signups, inconclusive: true },
    });
    return { verdict: "INCONCLUSIVE", approvalRequestId: req.id, reasoning: outcome.reasoning };
  }

  /**
   * Bootstrap an approved candidate into a live venture (#187 AC3 + AC4). Runs the factory scaling gate
   * FIRST (premortem FM#1: no new venture while one is unprofitable). Then plans the idempotent steps and
   * routes them by money class: reversible steps run autonomously (the fleet seed is the #138 seam), and
   * MONEY steps reserve their estimated spend against the hard cap before running. Only a cap raise parks
   * for the owner, so in-cap spend no longer needs per-action approval (#1055). Idempotent: a re-run
   * returns the same factory venture.
   */
  async bootstrap(
    workspaceId: string,
    candidateId: string,
    opts: { requesterMemberId: string; software?: boolean; includeAdSpend?: boolean; approvalRequestId?: string | null },
  ): Promise<BootstrapResult> {
    const caps = this.deps.caps(workspaceId);
    await this.assertAutonomyAllowed(workspaceId, caps);
    const candidate = await this.requireCandidate(workspaceId, candidateId);

    // The scaling gate (FM#1) only bars a NEW venture — a re-run of an already-bootstrapped candidate is
    // idempotent and never re-judged, so it can never be blocked by its own active count.
    const existing = await this.deps.store.getVentureByCandidate(workspaceId, candidateId);
    if (!existing) {
      const [activeVentures, profitableVentures] = await Promise.all([
        this.deps.store.countActiveVentures(workspaceId),
        this.deps.profitability.externallyProfitableCount(workspaceId),
      ]);
      const admission = decideFactoryAdmission({
        activeVentures,
        profitableVentures,
        maxConcurrentVentures: caps.maxConcurrentVentures,
        requireProfitableBeforeScale: caps.requireProfitableBeforeScale,
      });
      if (!admission.allowed) {
        throw new VentureFactoryDisabledError(admission.reason);
      }
    }

    const venture = await this.deps.store.ensureVenture({
      workspaceId,
      candidateId,
      name: candidate.proposedName,
      approvalRequestId: opts.approvalRequestId ?? null,
    });

    const plan = planBootstrap({
      candidateId,
      ventureName: candidate.proposedName,
      software: opts.software ?? false,
      includeAdSpend: opts.includeAdSpend ?? false,
      adSpendBudgetCents: caps.validationBudgetCapCents,
    });

    // Reversible, autonomous steps run now. The fleet seed and (#195) the deploy-target provision are the
    // only ones with a real side effect here; the rest (workspace/brand/landing/budget caps) are wired in
    // default.ts as the seam matures.
    const ranSteps: BootstrapStepKind[] = [];
    for (const step of autonomousSteps(plan)) {
      if (step.kind === "seed_fleet") {
        await this.deps.fleet.seed({ workspaceId, createdByMemberId: opts.requesterMemberId });
      } else if (step.kind === "repo_deploy_target") {
        // #195: provision the per-venture deploy target (Fly/Vercel project + envs + SSL + preview/prod).
        // Optional + idempotent + budget-capped; default-OFF / unwired ⇒ this stays a reversible no-op.
        await this.deps.deploy?.provision({
          workspaceId,
          ventureId: venture.id,
          ventureName: candidate.proposedName,
          createdByMemberId: opts.requesterMemberId,
        });
      }
      ranSteps.push(step.kind);
    }

    // MONEY/irreversible steps run only after their estimated spend fits inside the hard budget cap.
    // If the cap would be exceeded, park a cap-raise request instead of approving the action itself.
    const moneyDecisions: Array<{ kind: BootstrapStepKind; approvalRequestId: string }> = [];
    for (const step of moneySteps(plan)) {
      const cents = Math.max(0, Math.round(step.estimatedCostCents));
      const withinCap =
        cents === 0 ||
        (await this.deps.budget.charge(workspaceId, cents, `venture bootstrap ${step.kind}`));
      if (withinCap) {
        ranSteps.push(step.kind);
        continue;
      }

      const req = await this.deps.gate.submit({
        workspaceId,
        requesterMemberId: opts.requesterMemberId,
        actionKind: VENTURE_BOOTSTRAP_ACTION,
        amountCents: cents,
        summary: `Raise venture budget cap before ${step.summary}`,
        payload: {
          candidateId,
          ventureId: venture.id,
          step: step.kind,
          estimatedCostCents: cents,
          capRaiseRequired: true,
        },
      });
      moneyDecisions.push({ kind: step.kind, approvalRequestId: req.id });
    }

    await this.deps.store.setVenture(workspaceId, venture.id, { status: "launched" });
    await this.deps.store.setCandidate(workspaceId, candidateId, { status: "launched" });
    return { venture: { ...venture, status: "launched" }, ranSteps, moneyDecisions };
  }

  /**
   * Queue an externally sourced opportunity's deliverable through the existing approve-to-publish path
   * (#1061). This intentionally does NOT ship here. It parks an agent.deliverable request whose payload
   * already has the structural fields the #295 dispatcher needs after approval: a real channel id, task,
   * draft, and optional recipients. Once the owner approves the request, executeApprovedRequest runs the
   * existing agent.deliverable executor, which delegates to the delivery dispatcher and real connectors.
   */
  async queueOpportunityDelivery(
    workspaceId: string,
    candidateId: string,
    opts: {
      requesterMemberId: string;
      channelId: string;
      draft: string;
      recipients?: string[];
      sessionId?: string;
    },
  ): Promise<OpportunityDeliveryResult> {
    const caps = this.deps.caps(workspaceId);
    await this.assertAutonomyAllowed(workspaceId, caps);
    const candidate = await this.requireCandidate(workspaceId, candidateId);
    if (candidate.status === "killed") {
      throw new VentureFactoryDisabledError("cannot deliver a killed opportunity");
    }
    if (opts.draft.trim().length === 0) {
      throw new VentureFactoryDisabledError("opportunity deliverable draft is empty");
    }
    if (opts.channelId.trim().length === 0) {
      throw new VentureFactoryDisabledError("opportunity deliverable channel id is empty");
    }

    const task = "External opportunity: " + candidate.thesis;
    const req = await this.deps.gate.submit({
      workspaceId,
      requesterMemberId: opts.requesterMemberId,
      actionKind: AGENT_DELIVERABLE_ACTION,
      summary: 'Deliver opportunity "' + candidate.proposedName + '" via approve-to-publish',
      payload: {
        sessionId: opts.sessionId ?? "venture-factory:" + candidate.id,
        channelId: opts.channelId.trim(),
        task,
        draft: opts.draft,
        recipients: opts.recipients ?? [],
        opportunity: {
          candidateId: candidate.id,
          source: candidate.source,
          thesis: candidate.thesis,
          score: candidate.score,
          edgeStatus: candidate.edgeStatus,
          status: candidate.status,
        },
      },
    });
    return { approvalRequestId: req.id, actionKind: AGENT_DELIVERABLE_ACTION };
  }

  /**
   * Archive a venture cleanly after an owner-approved sunset (#187 AC5). The kill decision itself rides
   * the #107 portfolio SUNSET gate; here we tear down the factory venture: mark it `archived` (artifacts
   * retained) and run the archiver seam (cancel schedules, final P&L). Idempotent.
   */
  async archive(workspaceId: string, factoryVentureId: string, candidateId: string): Promise<void> {
    await this.deps.archiver.archive({ workspaceId, factoryVentureId, candidateId });
    await this.deps.store.setVenture(workspaceId, factoryVentureId, {
      status: "archived",
      archivedAt: this.now(),
    });
  }

  /**
   * One autopilot pass over a workspace's `scanned` candidates (the continuous-scanner tick, #187 AC1):
   * each candidate above the score floor is run through `validate` (which edge-gates it). A no-op when
   * the factory is disabled. Errors per-candidate are isolated so one bad candidate never stalls the
   * pass. Validation *conclusion* is receipt-driven (external), not part of this tick.
   */
  async advanceWorkspace(workspaceId: string, opts: { requesterMemberId: string }): Promise<void> {
    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return;
    const scanned = await this.deps.store.listCandidatesByStatus(workspaceId, "scanned", 25);
    for (const candidate of scanned) {
      try {
        await this.validate(workspaceId, candidate.id, { requesterMemberId: opts.requesterMemberId });
      } catch {
        // isolated: a single candidate's failure (e.g. a transient gate error) never stalls the pass.
      }
    }
  }

  private async requireCandidate(workspaceId: string, candidateId: string): Promise<CandidateRecord> {
    const candidate = await this.deps.store.getCandidate(workspaceId, candidateId);
    if (!candidate) throw new CandidateNotFoundError(candidateId);
    return candidate;
  }
}

function cleanOpportunityText(raw: string, maxLength: number): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
