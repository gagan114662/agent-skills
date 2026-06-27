import type { FastifyBaseLogger } from "fastify";
import { loadConfig } from "../config/loader.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { getMemberRole } from "../db/repositories/governance.js";
import {
  approveAndLock,
  getRequest,
  rejectRequest,
  type ApprovalRequest,
} from "../db/repositories/approvals.js";
import { executeApprovedRequest } from "../approvals/execute.js";
import { defaultRegistry } from "../approvals/runtime.js";
import { broadcastApprovalCompletion } from "../approvals/notifications.js";
import { decideApprovalClear, resolveRbacConfig } from "../team/rbac.js";
import type { VisibilityChannelCommand } from "./visibility-commands.js";

export type RoomApprovalDecisionResult =
  | { status: "not_applicable" }
  | { status: "intent_only"; reason: "approval_request_id_required" | "decider_identity_required" }
  | { status: "forbidden"; error: string; request?: ApprovalRequest }
  | { status: "conflict"; error: string; request?: ApprovalRequest }
  | { status: "expired"; request: ApprovalRequest }
  | { status: "rejected"; request: ApprovalRequest }
  | { status: "executed"; request: ApprovalRequest }
  | { status: "failed"; error: string | null; request: ApprovalRequest };

const APPROVAL_ID_PATTERN =
  /\b(?:approval|request|rid|#13)[:#\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

function extractApprovalRequestId(command: VisibilityChannelCommand): string | null {
  if (command.kind !== "approval_decision") return null;
  const match = APPROVAL_ID_PATTERN.exec(command.target);
  return match?.[1] ?? null;
}

async function canClearApproval(workspaceId: string, memberId: string): Promise<boolean> {
  const enabled = resolveRbacConfig(loadConfig(workspaceId).rbac).enabled;
  const role = enabled ? await getMemberRole(workspaceId, memberId) : null;
  return decideApprovalClear({ rbacEnabled: enabled, role }).decision !== "deny";
}

/**
 * Execute an explicit approval decision that arrived from a signed external room bridge (#1267).
 *
 * This is deliberately stricter than the intent parser: a chat reply only clears #13 when it names a
 * concrete request id and the bridge can attribute the reply to a human member who passes the same
 * humans-only, RBAC, and cannot-approve-own-request guards as REST/Slack. Otherwise the reply remains
 * visible intent in the room and no side effect runs.
 */
export async function decideRoomApprovalCommand(input: {
  workspaceId: string;
  deciderMemberId: string | null;
  command: VisibilityChannelCommand | null;
  provider: "imessage" | "telegram" | "whatsapp";
  log: FastifyBaseLogger;
}): Promise<RoomApprovalDecisionResult | null> {
  const command = input.command;
  if (!command || command.kind !== "approval_decision") return null;
  const requestId = extractApprovalRequestId(command);
  if (!requestId) return { status: "intent_only", reason: "approval_request_id_required" };
  if (!input.deciderMemberId) return { status: "intent_only", reason: "decider_identity_required" };

  const member = await getWorkspaceMember(input.deciderMemberId, input.workspaceId);
  if (!member || member.kind !== "human") {
    return { status: "forbidden", error: "only human members can decide approvals from external rooms" };
  }
  if (!(await canClearApproval(input.workspaceId, input.deciderMemberId))) {
    return { status: "forbidden", error: "member role cannot clear approvals from external rooms" };
  }

  const request = await getRequest(requestId);
  if (!request || request.workspaceId !== input.workspaceId) {
    return { status: "conflict", error: "approval request not found in this workspace" };
  }
  if (request.requesterMemberId === input.deciderMemberId) {
    return { status: "forbidden", error: "cannot approve your own request", request };
  }

  const reason = command.reason ? `via ${input.provider}: ${command.reason}` : `via ${input.provider}`;
  if (command.decision === "reject") {
    const rejected = await rejectRequest(requestId, input.workspaceId, input.deciderMemberId, reason);
    if (rejected.outcome === "expired") return { status: "expired", request: rejected.request };
    if (rejected.outcome !== "rejected") return { status: "conflict", error: "request already decided", request };
    await broadcastApprovalCompletion(input.log, rejected.request, input.deciderMemberId, "rejected");
    return { status: "rejected", request: rejected.request };
  }

  const approved = await approveAndLock(requestId, input.workspaceId, input.deciderMemberId, reason);
  if (approved.outcome === "expired") return { status: "expired", request: approved.request };
  if (approved.outcome !== "approved") return { status: "conflict", error: "request already decided", request };

  const execution = await executeApprovedRequest(defaultRegistry, approved.request, input.log);
  if (execution.outcome === "conflict") {
    return { status: "conflict", error: "request already executed", request: execution.request ?? approved.request };
  }
  const finished = execution.request;
  if (finished.status === "failed") {
    await broadcastApprovalCompletion(input.log, finished, input.deciderMemberId, "failed");
    return { status: "failed", error: finished.error, request: finished };
  }
  await broadcastApprovalCompletion(input.log, finished, input.deciderMemberId, "executed");
  return { status: "executed", request: finished };
}
