/**
 * Production wiring for the shared decision store (issue #513). Binds the pure {@link DecisionService} to
 * the real repos: persistence over `agent_decisions`, the mirror into the #15 memory graph (`upsertMemory`,
 * so every decision is browsable in the existing Memory view), the #14 task link, and the #13 approval gate
 * (`createRequest`, parked PENDING) for any external/money action a decision implies. No new authority and
 * no send/spend: recording a decision is an internal memory write; anything outbound stays behind the gate.
 */
import {
  getDecision,
  listDecisions,
  recallDecisions,
  recordDecision,
  supersedeDecision,
} from "../db/repositories/agent-decisions.js";
import { upsertMemory } from "../db/repositories/memories.js";
import { addTaskLink } from "../db/repositories/tasks.js";
import { createRequest } from "../db/repositories/approvals.js";
import { DecisionService, type DecisionDeps } from "./service.js";

export function createDefaultDecisionService(): DecisionService {
  const deps: DecisionDeps = {
    record: (input) =>
      recordDecision({
        workspaceId: input.workspaceId,
        topic: input.topic,
        title: input.title,
        rationale: input.rationale,
        dedupeKey: input.dedupeKey,
        decidedByMemberId: input.decidedByMemberId,
        memoryId: input.memoryId,
        taskId: input.taskId,
        approvalRequestId: input.approvalRequestId,
      }),
    supersede: (input) =>
      supersedeDecision({
        workspaceId: input.workspaceId,
        oldId: input.oldId,
        topic: input.topic,
        title: input.title,
        rationale: input.rationale,
        dedupeKey: input.dedupeKey,
        decidedByMemberId: input.decidedByMemberId,
        memoryId: input.memoryId,
        taskId: input.taskId,
        approvalRequestId: input.approvalRequestId,
      }),
    getDecision,
    listDecisions,
    recallDecisions,
    mirrorToMemory: async (input) => {
      const r = await upsertMemory({
        workspaceId: input.workspaceId,
        type: "decision",
        content: { text: input.title, rationale: input.rationale },
        entity: input.topic,
        dedupeKey: input.dedupeKey,
        sourceType: input.sourceId ? "task" : "event",
        sourceId: input.sourceId,
        createdByMemberId: input.createdByMemberId,
      });
      return r.id;
    },
    parkApproval: async (input) => {
      const request = await createRequest({
        workspaceId: input.workspaceId,
        requesterMemberId: input.requesterMemberId,
        actionType: input.actionType,
        payload: input.payload,
        amount: input.amount,
        summary: input.summary,
        // PENDING: the decision is recorded, but its external/money action waits on a human (#13).
        status: "pending",
        expiresAt: null,
        events: [{ type: "requested", detail: { source: "decision" } }],
      });
      return request.id;
    },
    linkTaskMemory: async (input) => {
      await addTaskLink({
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        targetType: "memory",
        targetId: input.memoryId,
        createdByMemberId: input.createdByMemberId,
      });
    },
  };
  return new DecisionService(deps);
}
