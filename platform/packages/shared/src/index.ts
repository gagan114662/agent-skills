/**
 * Cross-cutting contracts shared between the Reload server, web client, and CLI.
 * Keep this package free of runtime dependencies — types and small pure helpers only.
 */

/** Health of a single backing dependency. */
export type DependencyState = "up" | "down";

/** Overall service health, returned by `GET /healthz`. */
export interface HealthResponse {
  status: "ok" | "degraded";
  db: DependencyState;
  redis: DependencyState;
}

/** Liveness probe response (`GET /livez`) — the process is up. */
export interface LivenessResponse {
  status: "ok";
}

/**
 * Readiness probe response (`GET /readyz`) — every backing dependency is reachable.
 * Served with HTTP 200 when ready, 503 when not (`status: "not_ready"`).
 */
export interface ReadinessResponse {
  status: "ready" | "not_ready";
  db: DependencyState;
  redis: DependencyState;
}

// ---- approval gates (#13) ---------------------------------------------------

/** Lifecycle of an approval request (#13). `approved` is transient between decision and execution. */
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "executed"
  | "failed"
  | "rejected"
  | "expired";

/** Action types the executor registry can run (#13). */
export type ApprovalActionType = "chat.post_message" | "external.send";

/** A workspace policy rule: which action types pause for a human (#13). */
export interface ApprovalPolicyDto {
  id: string;
  actionType: string;
  requireApproval: boolean;
  maxAutoAmount: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A gated action awaiting (or having received) a human decision (#13). */
export interface ApprovalRequestDto {
  id: string;
  workspaceId: string;
  requesterMemberId: string;
  actionType: string;
  payload: Record<string, unknown>;
  amount: number | null;
  summary: string;
  status: ApprovalStatus;
  reason: string | null;
  decidedByMemberId: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An append-only audit row for an approval request (#13). */
export interface ApprovalEventDto {
  id: string;
  requestId: string;
  type: "requested" | "approved" | "rejected" | "expired" | "executed" | "failed";
  actorMemberId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** Response of `POST /workspaces/:wid/actions`: gated (pending) or auto-executed. */
export type SubmitActionResponse =
  | { status: "pending"; reason: string; request: ApprovalRequestDto }
  | { status: "executed"; result: Record<string, unknown>; request: ApprovalRequestDto };
