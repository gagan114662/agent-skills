import type { FastifyBaseLogger } from "fastify";
import type { ExecutorRegistry } from "./executor.js";
import { ActionExecutionError } from "./runtime.js";
import { getRequest, recordExecution, type ApprovalRequest } from "../db/repositories/approvals.js";

export type ApprovalExecutionOutcome =
  | { outcome: "executed"; request: ApprovalRequest }
  | { outcome: "failed"; request: ApprovalRequest }
  | { outcome: "conflict"; request?: ApprovalRequest };

/**
 * Run an approved request's executor AS the requester and record the outcome (#13). Extracted from the
 * approvals route so the exact same execution path is reused by the #170 Slack interactivity round-trip
 * — a Slack Approve button must execute identically to the REST `/approvals/:rid/approve` (same executor,
 * same `recordExecution` audit, same failure mapping). Maps any failure onto the `failed` outcome.
 */
export async function executeApprovedRequest(
  registry: ExecutorRegistry,
  request: ApprovalRequest,
  log: FastifyBaseLogger,
): Promise<ApprovalExecutionOutcome> {
  const current = await getRequest(request.id);
  if (!current || current.workspaceId !== request.workspaceId) return { outcome: "conflict" };
  if (current.status !== "pending" && current.status !== "approved") {
    return { outcome: "conflict", request: current };
  }

  const executor = registry.get(current.actionType);
  if (!executor) {
    const recorded = await recordExecution(current.id, current.workspaceId, {
      ok: false,
      error: `no executor for ${current.actionType}`,
    });
    return recorded.outcome === "recorded"
      ? { outcome: "failed", request: recorded.request }
      : { outcome: "conflict", request: recorded.request };
  }
  try {
    const result = await executor.execute(current.payload, {
      workspaceId: current.workspaceId,
      requesterMemberId: current.requesterMemberId,
      log,
      requestId: current.id,
    });
    const recorded = await recordExecution(current.id, current.workspaceId, { ok: true, result });
    return recorded.outcome === "recorded"
      ? { outcome: "executed", request: recorded.request }
      : { outcome: "conflict", request: recorded.request };
  } catch (err) {
    const error = err instanceof ActionExecutionError ? err.message : "execution failed";
    if (!(err instanceof ActionExecutionError)) log.error({ err }, "approval execution failed");
    const recorded = await recordExecution(current.id, current.workspaceId, { ok: false, error });
    return recorded.outcome === "recorded"
      ? { outcome: "failed", request: recorded.request }
      : { outcome: "conflict", request: recorded.request };
  }
}
