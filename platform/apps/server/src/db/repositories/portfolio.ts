import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { portfolioReviews } from "../schema/index.js";
import type {
  PortfolioDecision,
  PortfolioReviewRecord,
  PortfolioReviewStatus,
} from "../../portfolio/types.js";

/**
 * Portfolio review ledger repository (#107, ADR-0107). Workspace-scoped throughout (the #3 IDOR
 * discipline); the pure decision lives in `../../portfolio/decide.ts` — this is persistence only.
 */

const REVIEW_COLS = {
  id: portfolioReviews.id,
  workspaceId: portfolioReviews.workspaceId,
  ventureIdeaId: portfolioReviews.ventureIdeaId,
  decision: portfolioReviews.decision,
  score: portfolioReviews.score,
  growthScore: portfolioReviews.growthScore,
  moatScore: portfolioReviews.moatScore,
  moatStagnant: portfolioReviews.moatStagnant,
  demandSignals: portfolioReviews.demandSignals,
  revenueCents: portfolioReviews.revenueCents,
  monthlyCostCents: portfolioReviews.monthlyCostCents,
  netCents: portfolioReviews.netCents,
  ageInDays: portfolioReviews.ageInDays,
  reasons: portfolioReviews.reasons,
  status: portfolioReviews.status,
  approvalRequestId: portfolioReviews.approvalRequestId,
  createdByMemberId: portfolioReviews.createdByMemberId,
  createdAt: portfolioReviews.createdAt,
} as const;

/** Persist one portfolio review (the evidence snapshot + decision). `status` defaults to `recorded`. */
export async function insertReview(input: {
  workspaceId: string;
  ventureIdeaId: string;
  decision: PortfolioDecision;
  score: number;
  growthScore: number;
  moatScore: number;
  moatStagnant: boolean;
  demandSignals: number;
  revenueCents: number;
  monthlyCostCents: number;
  netCents: number;
  ageInDays: number;
  reasons: string[];
  createdByMemberId: string | null;
  createdAt?: Date;
}): Promise<PortfolioReviewRecord> {
  const [row] = await db
    .insert(portfolioReviews)
    .values({
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId,
      decision: input.decision,
      // integers are clamped/rounded so an upstream float never violates the column type.
      score: Math.round(input.score),
      growthScore: Math.round(input.growthScore),
      moatScore: Math.round(input.moatScore),
      moatStagnant: input.moatStagnant,
      demandSignals: Math.max(0, Math.trunc(input.demandSignals)),
      revenueCents: Math.round(input.revenueCents),
      monthlyCostCents: Math.round(input.monthlyCostCents),
      netCents: Math.round(input.netCents),
      ageInDays: Math.max(0, Math.trunc(input.ageInDays)),
      reasons: input.reasons,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      createdByMemberId: input.createdByMemberId,
    })
    .returning(REVIEW_COLS);
  return row as PortfolioReviewRecord;
}

/** Every review for a workspace, newest-first — the dashboard + Founder Console roll-up read. */
export async function listReviews(workspaceId: string): Promise<PortfolioReviewRecord[]> {
  const rows = await db
    .select(REVIEW_COLS)
    .from(portfolioReviews)
    .where(eq(portfolioReviews.workspaceId, workspaceId))
    .orderBy(desc(portfolioReviews.createdAt))
    .limit(500);
  return rows as PortfolioReviewRecord[];
}

/** One review by id, workspace-scoped (the #3 IDOR boundary). */
export async function getReview(
  workspaceId: string,
  id: string,
): Promise<PortfolioReviewRecord | undefined> {
  const [row] = await db
    .select(REVIEW_COLS)
    .from(portfolioReviews)
    .where(and(eq(portfolioReviews.workspaceId, workspaceId), eq(portfolioReviews.id, id)))
    .limit(1);
  return row as PortfolioReviewRecord | undefined;
}

/** Patch a review's SUNSET lifecycle (status, and the gating #13 request when it is first gated). */
export async function setReviewSunset(
  workspaceId: string,
  id: string,
  patch: { status: PortfolioReviewStatus; approvalRequestId?: string | null },
): Promise<PortfolioReviewRecord | undefined> {
  const [row] = await db
    .update(portfolioReviews)
    .set({
      status: patch.status,
      ...(patch.approvalRequestId !== undefined
        ? { approvalRequestId: patch.approvalRequestId }
        : {}),
    })
    .where(and(eq(portfolioReviews.workspaceId, workspaceId), eq(portfolioReviews.id, id)))
    .returning(REVIEW_COLS);
  return row as PortfolioReviewRecord | undefined;
}
