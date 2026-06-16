import type { FastifyBaseLogger } from "fastify";
import type { ExecutorRegistry } from "./executor.js";
import { ActionExecutionError } from "./runtime.js";
import { recordExecution, type ApprovalRequest } from "../db/repositories/approvals.js";

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
): Promise<ApprovalRequest> {
  const executor = registry.get(request.actionType);
  if (!executor) {
    return recordExecution(request.id, request.workspaceId, {
      ok: false,
      error: `no executor for ${request.actionType}`,
    });
  }
  try {
    const result = await executor.execute(request.payload, {
      workspaceId: request.workspaceId,
      requesterMemberId: request.requesterMemberId,
      log,
      requestId: request.id,
    });
    return recordExecution(request.id, request.workspaceId, { ok: true, result });
  } catch (err) {
    const error = err instanceof ActionExecutionError ? err.message : "execution failed";
    if (!(err instanceof ActionExecutionError)) log.error({ err }, "approval execution failed");
    return recordExecution(request.id, request.workspaceId, { ok: false, error });
  }
}
