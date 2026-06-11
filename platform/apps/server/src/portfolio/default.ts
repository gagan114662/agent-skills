import { PortfolioService, type PortfolioDeps } from "./service.js";
import { resolvePortfolioCaps } from "./caps.js";
import { loadConfig } from "../config/loader.js";
import { windowKey } from "../scale/usage.js";
import {
  insertReview,
  listReviews,
  getReview,
  setReviewSunset,
} from "../db/repositories/portfolio.js";
import { listEvaluations, updateIdeaStatus } from "../db/repositories/venture.js";
import { getUsage } from "../db/repositories/tenant-usage.js";
import {
  createRequest,
  getRequest,
  listPolicyRules,
} from "../db/repositories/approvals.js";
import { upsertMemory } from "../db/repositories/memories.js";
import { evaluatePolicy, PORTFOLIO_SUNSET_ACTION } from "../approvals/policy.js";
import type { MoatService } from "../moat/service.js";
import type { GrowthService } from "../growth/service.js";
import type { DemandValidationService } from "../demand/service.js";
import type { BillingManager } from "../billing/manager.js";

/**
 * Production wiring for the Portfolio Lifecycle Loop (#107, ADR-0107). Reads the LIVE moat (#103),
 * growth (#102), demand (#101), and billing (#98) surfaces — so the portfolio KPIs match the rest of
 * the platform — plus `tenant_usage` (#71) for the burn. Launched ventures are funded evaluations
 * (`terminalVerdict === 'FUND'`); `launchedAt` is when the evaluation went terminal (`updatedAt`). The
 * SUNSET gate evaluates `portfolio.sunset` against the same #13 `approval_policies` (sensitive by
 * default), creating a **pending** request a human approves; the post-mortem is the #15 memory graph.
 */
export function createDefaultPortfolioService(deps: {
  moat: MoatService;
  growth: GrowthService;
  demand: DemandValidationService;
  billing: BillingManager;
  now?: () => Date;
}): PortfolioService {
  const { moat, growth, demand, billing } = deps;

  const wiring: PortfolioDeps = {
    // Launched = a funded venture (#96 `terminalVerdict === 'FUND'`); launchedAt = went-terminal time.
    launch: {
      launched: async (workspaceId) =>
        (await listEvaluations(workspaceId))
          .filter((e) => e.terminalVerdict === "FUND")
          .map((e) => ({ ventureIdeaId: e.ideaId, launchedAt: e.updatedAt })),
    },
    // #102 per-venture growth score (events scoped to the idea).
    growth: {
      score: async (workspaceId, ventureIdeaId) =>
        (await growth.summary(workspaceId, ventureIdeaId)).score,
    },
    // #103 per-venture moat roll-up — zero-accrual ventures come back scored 0 + stagnant.
    moat: {
      portfolio: async (workspaceId, ventureIdeaIds) =>
        (await moat.portfolioMoat(workspaceId, ventureIdeaIds)).map((m) => ({
          ventureIdeaId: m.ventureIdeaId,
          score: m.score,
          stagnant: m.stagnant,
        })),
    },
    // #101 external willingness-to-pay signals earned (the demand gauge).
    demand: {
      signalCount: async (workspaceId, ventureIdeaId) =>
        (await demand.externalDemandEvidence(workspaceId, ventureIdeaId)).length,
    },
    // #98 workspace revenue (per-workspace in the current rails; see ADR-0107).
    revenue: {
      workspaceRevenueCents: async (workspaceId) => (await billing.revenue(workspaceId)).totalCents,
    },
    // #71 current-window infra burn.
    cost: {
      monthlyCostCents: async (workspaceId, now) =>
        (await getUsage(workspaceId, windowKey(now))).estimatedCostCents,
    },
    store: {
      insert: insertReview,
      list: listReviews,
      get: getReview,
      setSunset: setReviewSunset,
    },
    // #13 sunset gate: `portfolio.sunset` is sensitive by default — evaluate the workspace policy, and
    // when gated create a PENDING request a human must approve (an agent never approves its own kill).
    gate: {
      requiresApproval: async (workspaceId) =>
        evaluatePolicy(
          { actionType: PORTFOLIO_SUNSET_ACTION },
          await listPolicyRules(workspaceId),
        ).requiresApproval,
      submit: async (input) => {
        const req = await createRequest({
          workspaceId: input.workspaceId,
          requesterMemberId: input.requesterMemberId,
          actionType: PORTFOLIO_SUNSET_ACTION,
          payload: input.payload,
          amount: null,
          summary: input.summary,
          status: "pending", // portfolio.sunset is sensitive-by-default — always a human gate
          expiresAt: null,
          events: [{ type: "requested", detail: { source: "portfolio", ...input.payload } }],
        });
        return { id: req.id };
      },
      status: async (approvalRequestId) => (await getRequest(approvalRequestId))?.status,
    },
    // #15 memory graph: the sunset post-mortem so the lesson compounds (mirrors the #96 KILL→memory path).
    memory: {
      recordSunset: async (input) => {
        await upsertMemory({
          workspaceId: input.workspaceId,
          type: "decision",
          content: { text: input.reasoning, kind: "portfolio_sunset", ventureIdeaId: input.ventureIdeaId },
          entity: input.ventureIdeaId,
          dedupeKey: `portfolio:sunset:${input.ventureIdeaId}`,
          // within the memories_source_type_ck set (message|task|file|event|manual); a sunset is a
          // lifecycle event. The `kind: "portfolio_sunset"` discriminator lives in `content`.
          sourceType: "event",
          createdByMemberId: input.createdByMemberId,
        });
      },
    },
    // #96 flip the funded idea to `killed` on an executed sunset.
    venture: {
      markKilled: async (workspaceId, ventureIdeaId) =>
        updateIdeaStatus(workspaceId, ventureIdeaId, "killed"),
    },
    caps: (workspaceId) => resolvePortfolioCaps(loadConfig(workspaceId).portfolio),
    now: deps.now,
  };

  return new PortfolioService(wiring);
}
