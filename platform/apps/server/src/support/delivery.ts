import type { ExecutorContext } from "../approvals/executor.js";

export interface SupportReplyPayload {
  kind?: unknown;
  summary?: unknown;
  target?: unknown;
  ticketId?: unknown;
}

export interface SupportReplyDeliveryDispatcher {
  dispatch(
    payload: SupportReplyPayload,
    ctx: Pick<ExecutorContext, "workspaceId" | "requesterMemberId" | "requestId">,
  ): Promise<Record<string, unknown> | null>;
}

