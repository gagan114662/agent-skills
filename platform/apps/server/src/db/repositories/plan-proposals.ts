import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { planProposals } from "../schema/index.js";

/** A plan proposal's lifecycle status (mirrors `turns/plan.ts` `PlanStatus`). */
export type PlanProposalStatus = "proposed" | "approved" | "approved_with_feedback" | "rejected";

export interface PlanProposal {
  id: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
  planSessionId: string | null;
  originalTask: string;
  planText: string;
  status: PlanProposalStatus;
  feedback: string | null;
  executionSessionId: string | null;
  createdByMemberId: string | null;
  decidedByMemberId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

const COLUMNS = {
  id: planProposals.id,
  workspaceId: planProposals.workspaceId,
  channelId: planProposals.channelId,
  agentMemberId: planProposals.agentMemberId,
  planSessionId: planProposals.planSessionId,
  originalTask: planProposals.originalTask,
  planText: planProposals.planText,
  status: planProposals.status,
  feedback: planProposals.feedback,
  executionSessionId: planProposals.executionSessionId,
  createdByMemberId: planProposals.createdByMemberId,
  decidedByMemberId: planProposals.decidedByMemberId,
  createdAt: planProposals.createdAt,
  decidedAt: planProposals.decidedAt,
} as const;

export async function createPlanProposal(input: {
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
  planSessionId: string | null;
  originalTask: string;
  planText: string;
  createdByMemberId: string;
}): Promise<PlanProposal> {
  const [row] = await db
    .insert(planProposals)
    .values({ ...input, status: "proposed" })
    .returning(COLUMNS);
  return row as PlanProposal;
}

/** Fetch a proposal scoped to its channel (prevents cross-channel/tenant reads — IDOR). */
export async function getPlanProposal(
  id: string,
  channelId: string,
): Promise<PlanProposal | undefined> {
  const [row] = await db
    .select(COLUMNS)
    .from(planProposals)
    .where(and(eq(planProposals.id, id), eq(planProposals.channelId, channelId)))
    .limit(1);
  return row as PlanProposal | undefined;
}

/** A channel's proposals, newest first. */
export async function listPlanProposals(channelId: string): Promise<PlanProposal[]> {
  const rows = await db
    .select(COLUMNS)
    .from(planProposals)
    .where(eq(planProposals.channelId, channelId))
    .orderBy(desc(planProposals.createdAt));
  return rows as PlanProposal[];
}

/** Record a decision on a proposal: terminal status + feedback + decider + (optional) execution session. */
export async function decidePlanProposal(
  id: string,
  fields: {
    status: PlanProposalStatus;
    feedback: string | null;
    decidedByMemberId: string;
    executionSessionId?: string | null;
  },
): Promise<void> {
  await db
    .update(planProposals)
    .set({
      status: fields.status,
      feedback: fields.feedback,
      decidedByMemberId: fields.decidedByMemberId,
      executionSessionId: fields.executionSessionId ?? null,
      decidedAt: new Date(),
    })
    .where(eq(planProposals.id, id));
}
