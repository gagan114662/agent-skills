import { GrowthService, type ExternalPostGate } from "./service.js";
import { resolveGrowthCaps } from "./caps.js";
import { loadConfig } from "../config/loader.js";
import {
  insertEvent,
  listEvents,
  insertExperiment,
  getExperiment,
  listExperiments,
  linkExperimentApproval,
  updateExperimentStatus,
  completeExperiment,
} from "../db/repositories/growth.js";
import { createRequest } from "../db/repositories/approvals.js";

/**
 * Production wiring for the Growth Loop (#102, ADR-0102). The event log + experiment ledger are backed
 * by the workspace-scoped `growth` repo; the external-post gate creates a **pending** #13 approval
 * request (`external.send` is sensitive-by-default, ADR-0013) so a human approves + posts. No change to
 * `approvals/policy.ts` or the executor — promotion reuses the existing gate verbatim.
 */

/** The #13 gate: a marketing external post becomes a pending approval the owner reviews in #104. */
const externalPostGate: ExternalPostGate = {
  submit: async (input) => {
    const req = await createRequest({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: input.actionType,
      payload: input.payload,
      amount: input.amount,
      summary: input.summary,
      status: "pending", // external.send is sensitive-by-default — always a human gate
      expiresAt: null,
      events: [{ type: "requested", detail: { source: "growth", ...input.payload } }],
    });
    return { id: req.id };
  },
};

export function createDefaultGrowthService(): GrowthService {
  return new GrowthService({
    events: { insert: insertEvent, list: listEvents },
    experiments: {
      insert: insertExperiment,
      get: getExperiment,
      list: listExperiments,
      linkApproval: (workspaceId, id, approvalRequestId, now) =>
        linkExperimentApproval(workspaceId, id, approvalRequestId, now),
      updateStatus: updateExperimentStatus,
      complete: completeExperiment,
    },
    gate: externalPostGate,
    caps: (workspaceId) => resolveGrowthCaps(loadConfig(workspaceId).growth),
  });
}
