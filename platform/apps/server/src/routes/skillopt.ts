import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import {
  listSkillOptProposals,
  type SkillOptProposalRow,
} from "../db/repositories/skillopt-runs.js";
import { SKILLOPT_PROPOSAL_STATUSES } from "../db/schema/index.js";

const STATUS = new Set<string>(SKILLOPT_PROPOSAL_STATUSES);

function toDto(row: SkillOptProposalRow) {
  return {
    id: row.id,
    runId: row.runId,
    workspaceId: row.workspaceId,
    agentHandle: row.agentHandle,
    skillId: row.skillId,
    status: row.status,
    skipReason: row.skipReason,
    clusterKey: row.clusterKey,
    metric: row.metric,
    higherIsBetter: row.higherIsBetter,
    baseline: row.baseline,
    candidate: row.candidate,
    improvementRatio: row.improvementRatio,
    sampleSize: row.sampleSize,
    externallyVerified: row.externallyVerified,
    currentDocSha: row.currentDocSha,
    requestId: row.requestId,
    createdAt: new Date(row.createdAtMs).toISOString(),
  };
}

/**
 * SkillOpt console routes (#1065). Read-only over the SkillOpt ledger; adopt/reject remains the existing
 * #13 approval request linked by requestId, so this route creates no parallel authority path.
 */
export async function skilloptRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/skillopt/proposals", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const q = req.query as { status?: string; limit?: string };
    if (q.status && !STATUS.has(q.status)) {
      return reply.code(400).send({ error: "invalid skillopt proposal status" });
    }
    const limit = q.limit ? Math.min(Math.max(Number(q.limit) || 50, 1), 200) : 50;
    const proposals = await listSkillOptProposals(id.workspaceId, {
      status: q.status as SkillOptProposalRow["status"] | undefined,
      limit,
    });
    return { proposals: proposals.map(toDto) };
  });
}
