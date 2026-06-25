import type { ApprovalStatus } from "../approvals/policy.js";
import type { PortfolioCaps } from "./caps.js";
import { decidePortfolio } from "./decide.js";
import type { PortfolioEvidence, PortfolioReviewRecord, PortfolioReviewStatus } from "./types.js";

/**
 * The Portfolio Lifecycle IO orchestrator (#107, ADR-0107). Declares one seam per data source (the
 * launched-venture reader, the growth/moat/demand/revenue/cost readers, the review store, the #13
 * sunset gate, the #15 memory recorder, the venture writer) + a config-resolved {@link PortfolioCaps};
 * the pure decision math lives in `decide.ts`. So the service runs against fakes in tests and the real
 * repos/services in `default.ts`. Computing/persisting/listing reviews is always available (read-mostly
 * audit); SUNSET execution is **always** #13-gated (kill discipline is never opt-out by `enabled`).
 */

const DAY_MS = 86_400_000;

/** A launched venture: the funded idea + when it launched (FUND), for the age signal. */
export interface LaunchedVenture {
  ventureIdeaId: string;
  launchedAt: Date;
}

/** The launched portfolio (funded ventures) — `terminalVerdict === 'FUND'` in prod. */
export interface LaunchReader {
  launched(workspaceId: string): Promise<LaunchedVenture[]>;
}

/** Per-venture growth score (#102), 0–100. */
export interface GrowthScoreReader {
  score(workspaceId: string, ventureIdeaId: string): Promise<number>;
}

/** Per-venture moat roll-up (#103): the 0–100 score + the stagnation flag. */
export interface MoatPortfolioReader {
  portfolio(
    workspaceId: string,
    ventureIdeaIds: string[],
  ): Promise<{ ventureIdeaId: string; score: number; stagnant: boolean }[]>;
}

/** Per-venture external demand signal count (#101). */
export interface DemandReader {
  signalCount(workspaceId: string, ventureIdeaId: string): Promise<number>;
}

/** Per-venture verified revenue in cents from external receipts (#386/#194). */
export interface RevenueReader {
  ventureVerifiedRevenueCents(workspaceId: string, ventureIdeaId: string): Promise<number>;
}

/** Current-window infra burn in cents (#71 `tenant_usage`). */
export interface CostReader {
  monthlyCostCents(workspaceId: string, now: Date): Promise<number>;
}

/** The durable review ledger. */
export interface PortfolioReviewStore {
  insert(
    input: Omit<PortfolioReviewRecord, "id" | "status" | "approvalRequestId" | "createdAt">,
  ): Promise<PortfolioReviewRecord>;
  list(workspaceId: string): Promise<PortfolioReviewRecord[]>;
  get(workspaceId: string, id: string): Promise<PortfolioReviewRecord | undefined>;
  setSunset(
    workspaceId: string,
    id: string,
    patch: { status: PortfolioReviewStatus; approvalRequestId?: string | null },
  ): Promise<PortfolioReviewRecord | undefined>;
}

/**
 * The #13 sunset gate: whether `portfolio.sunset` needs a human for this workspace, how to submit the
 * (sensitive-by-default) request, and how to read its current status. The descriptor is never an
 * {@link import("../approvals/policy.js").ActionType} (not route-submittable) — it is evaluated against
 * the same workspace `approval_policies`, like `autonomy.complete` / `dr.restore`.
 */
export interface SunsetGate {
  requiresApproval(workspaceId: string): Promise<boolean>;
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    summary: string;
    payload: Record<string, unknown>;
  }): Promise<{ id: string }>;
  status(approvalRequestId: string): Promise<ApprovalStatus | undefined>;
}

/** The #15 memory graph: write the sunset post-mortem so the lesson compounds. */
export interface PortfolioMemoryRecorder {
  recordSunset(input: {
    workspaceId: string;
    ventureIdeaId: string;
    reasoning: string;
    createdByMemberId: string | null;
  }): Promise<void>;
}

/** The venture writer: flip a sunset idea to `killed` (#96 `updateIdeaStatus`). */
export interface VentureKiller {
  markKilled(workspaceId: string, ventureIdeaId: string): Promise<void>;
}

export interface PortfolioDeps {
  launch: LaunchReader;
  growth: GrowthScoreReader;
  moat: MoatPortfolioReader;
  demand: DemandReader;
  revenue: RevenueReader;
  cost: CostReader;
  store: PortfolioReviewStore;
  gate: SunsetGate;
  memory: PortfolioMemoryRecorder;
  venture: VentureKiller;
  caps: (workspaceId: string) => PortfolioCaps;
  now?: () => Date;
}

export class PortfolioReviewNotFoundError extends Error {
  constructor(id: string) {
    super(`portfolio review not found: ${id}`);
    this.name = "PortfolioReviewNotFoundError";
  }
}

export class PortfolioNotSunsetError extends Error {
  constructor(id: string, decision: string) {
    super(`portfolio review ${id} is ${decision}, not SUNSET — cannot request a sunset`);
    this.name = "PortfolioNotSunsetError";
  }
}

export class PortfolioSunsetStateError extends Error {
  constructor(id: string, status: string, expected: string) {
    super(`portfolio review ${id} is ${status}; expected ${expected}`);
    this.name = "PortfolioSunsetStateError";
  }
}

export class PortfolioSunsetNotApprovedError extends Error {
  constructor(id: string) {
    super(`portfolio review ${id} sunset is not yet approved`);
    this.name = "PortfolioSunsetNotApprovedError";
  }
}

/** The result of requesting a sunset: gated (a pending #13 request) or auto-executed (workspace opt-out). */
export interface SunsetRequestResult {
  gated: boolean;
  approvalRequestId: string | null;
  review: PortfolioReviewRecord;
}

/** The result of executing a gated sunset after the human decision. */
export interface SunsetExecuteResult {
  executed: boolean;
  review: PortfolioReviewRecord;
}

export class PortfolioService {
  private readonly deps: PortfolioDeps;
  private readonly now: () => Date;

  constructor(deps: PortfolioDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Run the portfolio review tick: gather each launched venture's KPI evidence (growth #102, moat #103,
   * demand #101, revenue #98, infra burn #71), decide its fate (pure `decidePortfolio`), and persist a
   * review row. Read-mostly + tenant-scoped — always available; `enabled` gates only the proactive
   * Founder Console posture, not this analysis.
   */
  async reviewPortfolio(
    workspaceId: string,
    opts: { createdByMemberId?: string | null } = {},
  ): Promise<PortfolioReviewRecord[]> {
    const now = this.now();
    const caps = this.deps.caps(workspaceId);
    const launched = await this.deps.launch.launched(workspaceId);
    if (launched.length === 0) return [];

    const ids = launched.map((l) => l.ventureIdeaId);
    // Portfolio-level signals fetched once; the moat roll-up is one batched read for the whole portfolio.
    const [moatRollup, monthlyCostCents] = await Promise.all([
      this.deps.moat.portfolio(workspaceId, ids),
      this.deps.cost.monthlyCostCents(workspaceId, now),
    ]);
    const moatById = new Map(moatRollup.map((m) => [m.ventureIdeaId, m]));
    const revenueEntries = await Promise.all(
      ids.map(async (ventureIdeaId) => ({
        ventureIdeaId,
        revenueCents: await this.deps.revenue.ventureVerifiedRevenueCents(
          workspaceId,
          ventureIdeaId,
        ),
      })),
    );
    const revenueById = new Map(revenueEntries.map((r) => [r.ventureIdeaId, r.revenueCents]));
    const totalVerifiedRevenueCents = revenueEntries.reduce((sum, r) => sum + r.revenueCents, 0);

    const reviews = await Promise.all(
      launched.map(async (venture) => {
        const [growthScore, demandSignals] = await Promise.all([
          this.deps.growth.score(workspaceId, venture.ventureIdeaId),
          this.deps.demand.signalCount(workspaceId, venture.ventureIdeaId),
        ]);
        const moat = moatById.get(venture.ventureIdeaId);
        const ageInDays = Math.max(
          0,
          Math.floor((now.getTime() - venture.launchedAt.getTime()) / DAY_MS),
        );
        const evidence: PortfolioEvidence = {
          ventureIdeaId: venture.ventureIdeaId,
          growthScore,
          // a venture with no moat ledger rows scores 0 and is stagnant (the #103 default).
          moatScore: moat?.score ?? 0,
          moatStagnant: moat?.stagnant ?? true,
          demandSignals,
          revenueCents: revenueById.get(venture.ventureIdeaId) ?? 0,
          monthlyCostCents,
          ageInDays,
        };
        const assessment = decidePortfolio(evidence, caps);
        const allocationBps =
          totalVerifiedRevenueCents > 0
            ? Math.round((evidence.revenueCents / totalVerifiedRevenueCents) * 10_000)
            : 0;
        return this.deps.store.insert({
          workspaceId,
          ventureIdeaId: venture.ventureIdeaId,
          decision: assessment.decision,
          score: assessment.score,
          growthScore: evidence.growthScore,
          moatScore: evidence.moatScore,
          moatStagnant: evidence.moatStagnant,
          demandSignals: evidence.demandSignals,
          revenueCents: evidence.revenueCents,
          monthlyCostCents: evidence.monthlyCostCents,
          netCents: assessment.netCents,
          ageInDays: evidence.ageInDays,
          reasons: [
            ...assessment.reasons,
            totalVerifiedRevenueCents > 0
              ? "allocation: " +
                evidence.revenueCents +
                " cents verified revenue = " +
                allocationBps +
                "bps of portfolio receipts"
              : "allocation: no verified revenue receipts - scale weight 0",
          ],
          createdByMemberId: opts.createdByMemberId ?? null,
        });
      }),
    );
    return reviews;
  }

  /** Every review for a workspace, newest-first — the dashboard + Founder Console roll-up. */
  async listReviews(workspaceId: string): Promise<PortfolioReviewRecord[]> {
    return this.deps.store.list(workspaceId);
  }

  /**
   * Request a SUNSET (kill) of a launched venture. Evaluates the #13 policy: by default
   * `portfolio.sunset` is sensitive ⇒ a **pending** request is created and the review moves to
   * `sunset_pending` (NOTHING is torn down until a human approves). A workspace that has opted out with
   * a policy rule auto-executes the sunset immediately. Throws if the review is unknown, not a SUNSET,
   * or already in a sunset lifecycle.
   */
  async requestSunset(
    workspaceId: string,
    reviewId: string,
    input: { requesterMemberId: string },
  ): Promise<SunsetRequestResult> {
    const review = await this.requireRecordedSunset(workspaceId, reviewId);

    if (await this.deps.gate.requiresApproval(workspaceId)) {
      const req = await this.deps.gate.submit({
        workspaceId,
        requesterMemberId: input.requesterMemberId,
        summary: `Sunset venture ${review.ventureIdeaId} (portfolio health ${review.score})`,
        payload: {
          reviewId: review.id,
          ventureIdeaId: review.ventureIdeaId,
          decision: review.decision,
          score: review.score,
          netCents: review.netCents,
        },
      });
      const updated = await this.deps.store.setSunset(workspaceId, reviewId, {
        status: "sunset_pending",
        approvalRequestId: req.id,
      });
      return { gated: true, approvalRequestId: req.id, review: updated ?? review };
    }

    // Workspace opted out of the gate → execute now (an explicit, recorded policy choice).
    await this.performSunset(workspaceId, review, input.requesterMemberId);
    const updated = await this.deps.store.setSunset(workspaceId, reviewId, {
      status: "sunset_executed",
    });
    return { gated: false, approvalRequestId: null, review: updated ?? review };
  }

  /**
   * Execute a gated sunset after the human decision: read the linked #13 request's status; on
   * `approved`/`executed` write the post-mortem (#15) + flip the venture `killed` (#96) +
   * `sunset_executed`; on `rejected`/`expired` move to `sunset_rejected` (no teardown); while still
   * pending, refuse (an agent can never bypass its own gate — ADR-0013).
   */
  async executeSunset(
    workspaceId: string,
    reviewId: string,
    input: { actorMemberId: string | null },
  ): Promise<SunsetExecuteResult> {
    const review = await this.deps.store.get(workspaceId, reviewId);
    if (!review) throw new PortfolioReviewNotFoundError(reviewId);
    if (review.status !== "sunset_pending") {
      throw new PortfolioSunsetStateError(reviewId, review.status, "sunset_pending");
    }
    if (!review.approvalRequestId) {
      throw new PortfolioSunsetStateError(reviewId, "ungated", "a linked approval request");
    }

    const status = await this.deps.gate.status(review.approvalRequestId);
    if (status === "approved" || status === "executed") {
      await this.performSunset(workspaceId, review, input.actorMemberId);
      const updated = await this.deps.store.setSunset(workspaceId, reviewId, {
        status: "sunset_executed",
      });
      return { executed: true, review: updated ?? review };
    }
    if (status === "rejected" || status === "expired") {
      const updated = await this.deps.store.setSunset(workspaceId, reviewId, {
        status: "sunset_rejected",
      });
      return { executed: false, review: updated ?? review };
    }
    throw new PortfolioSunsetNotApprovedError(reviewId);
  }

  /** Load a review and assert it is a SUNSET still in the `recorded` state (ready to be requested). */
  private async requireRecordedSunset(
    workspaceId: string,
    reviewId: string,
  ): Promise<PortfolioReviewRecord> {
    const review = await this.deps.store.get(workspaceId, reviewId);
    if (!review) throw new PortfolioReviewNotFoundError(reviewId);
    if (review.decision !== "SUNSET") {
      throw new PortfolioNotSunsetError(reviewId, review.decision);
    }
    if (review.status !== "recorded") {
      throw new PortfolioSunsetStateError(reviewId, review.status, "recorded");
    }
    return review;
  }

  /** The irreversible half of a sunset: write the post-mortem to #15, then flip the idea `killed`. */
  private async performSunset(
    workspaceId: string,
    review: PortfolioReviewRecord,
    actorMemberId: string | null,
  ): Promise<void> {
    const reasoning = `SUNSET venture ${review.ventureIdeaId} (portfolio health ${review.score}, net ${review.netCents}¢): ${review.reasons.join("; ")}`;
    await this.deps.memory.recordSunset({
      workspaceId,
      ventureIdeaId: review.ventureIdeaId,
      reasoning,
      createdByMemberId: actorMemberId,
    });
    await this.deps.venture.markKilled(workspaceId, review.ventureIdeaId);
  }
}
