export interface ReviewQueueApproval {
  id: string;
  actionType: string;
  summary: string;
  payload: Record<string, unknown>;
}

const WATCHDOG_ESCALATION_ACTION = "watchdog.escalate";
const DELIVERABLE_ACTION = "agent.deliverable";
const WORKSPACE_FACTS_PREFIX = "workspace facts (reference data for your task";

function startsWithWorkspaceFacts(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase().startsWith(WORKSPACE_FACTS_PREFIX);
}

function isWorkspaceFactsDeliverable(request: ReviewQueueApproval): boolean {
  if (request.actionType !== DELIVERABLE_ACTION) return false;
  if (startsWithWorkspaceFacts(request.payload.task)) return true;
  if (startsWithWorkspaceFacts(request.summary.replace(/^deliverable ready for review:\s*/i, ""))) return true;
  return startsWithWorkspaceFacts(request.payload.draft);
}

export function isReviewQueueVisible(request: ReviewQueueApproval): boolean {
  if (request.actionType === WATCHDOG_ESCALATION_ACTION) return false;
  return !isWorkspaceFactsDeliverable(request);
}

export function filterReviewQueueApprovals<T extends ReviewQueueApproval>(requests: readonly T[]): T[] {
  return requests.filter(isReviewQueueVisible);
}
