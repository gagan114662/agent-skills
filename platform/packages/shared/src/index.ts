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

// ---- team mode (#TeamMode) --------------------------------------------------

/**
 * The lifecycle a teammate broadcasts on the shared team channel so peers can keep each other in
 * the loop: `started` (claimed a subtask), `milestone` (progress worth announcing), `blocked`
 * (stuck / failed — peers should avoid depending on it), `needs_handoff` (wants another agent to
 * pick something up), `done` (subtask finished). Reading recent events before acting is how agents
 * avoid duplicate or conflicting work.
 */
export type TeamEventKind = "started" | "milestone" | "blocked" | "needs_handoff" | "done";

/** One structured status event on a team run's channel. */
export interface TeamEvent {
  /** Groups every event belonging to one team run. */
  teamRunId: string;
  /** Which subtask/branch this event is about. */
  subtaskId: string;
  /** The agent member that emitted the event. */
  agentMemberId: string;
  kind: TeamEventKind;
  /** Human-readable one-liner describing what happened. */
  summary: string;
  /** The branch the agent is working on, or null before one is assigned. */
  branch: string | null;
  /** ISO-8601 timestamp the event was created. */
  createdAt: string;
}

// ---- git / PR / diff / review workflow (#51) --------------------------------

/** Which slice of a session's git history a diff covers (#51). */
export type DiffMode = "cumulative" | "turn";

/** Per-file change summary parsed from `git diff --numstat` (#51). */
export interface DiffFileStat {
  path: string;
  /** Lines added; null for a binary file (git reports `-`). */
  additions: number | null;
  /** Lines removed; null for a binary file. */
  deletions: number | null;
  binary: boolean;
}

/** A session's diff: the unified patch plus per-file stats (#51). */
export interface SessionDiff {
  sessionId: string;
  branch: string;
  baseBranch: string;
  mode: DiffMode;
  /** The unified-diff patch text (may be empty when there are no changes). */
  patch: string;
  files: DiffFileStat[];
}

/** Lifecycle of a pull request opened from a session (#51). */
export type PullRequestState = "draft" | "open" | "merged" | "closed";

/** CI/checks rollup for a PR, mirrored from GitHub (#51). */
export type ChecksStatus = "unknown" | "pending" | "success" | "failure";

/** One CI check run on a PR's head (#51). */
export interface CheckRunDto {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "skipped" | "cancelled" | null;
  detailsUrl: string | null;
}

/** A pull request opened from an agent session's branch (#51). */
export interface PullRequestDto {
  id: string;
  workspaceId: string;
  channelId: string;
  sessionId: string | null;
  number: number | null;
  url: string | null;
  title: string;
  body: string | null;
  draft: boolean;
  state: PullRequestState;
  checksStatus: ChecksStatus;
  baseBranch: string;
  headBranch: string;
  provider: "none" | "gh";
  createdByMemberId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A review comment on a session's diff, optionally delivered back to the agent (#51). */
export interface ReviewCommentDto {
  id: string;
  workspaceId: string;
  channelId: string;
  sessionId: string;
  pullRequestId: string | null;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  body: string;
  authorMemberId: string | null;
  /** The follow-up session this comment was forwarded to (the round-trip), or null. */
  deliveredToSessionId: string | null;
  createdAt: string;
}

// ---- run tab / preview + annotations (#56) ----------------------------------

/** Lifecycle of a session's run process (#56). Ephemeral — a child of the server, never persisted. */
export type RunStatus = "idle" | "starting" | "running" | "stopped" | "exited" | "failed";

/** A session's run-process state, surfaced to the Run tab (#56). */
export interface RunState {
  sessionId: string;
  status: RunStatus;
  /** The detected (or configured) localhost preview URL once the app is up; null otherwise. */
  url: string | null;
  /** Exit code once the process has exited on its own; null otherwise. */
  exitCode: number | null;
  /** A spawn/runtime error message when status is `failed`; null otherwise. */
  error: string | null;
  /** A bounded tail of the process's combined stdout/stderr lines (oldest first). */
  logs: string[];
}

/**
 * A user annotation dropped on the running preview (#56). Coordinates are **normalized fractions**
 * (0–1) of the preview viewport, so they stay stable across pixel sizes. The localhost app is
 * cross-origin, so an annotation is a coordinate + the user's note — never page DOM content.
 */
export interface PreviewAnnotation {
  /** Normalized x (0–1) of the annotation anchor within the preview viewport. */
  x: number;
  /** Normalized y (0–1) of the annotation anchor within the preview viewport. */
  y: number;
  /** Optional normalized width (0–1) of a dragged region. */
  width?: number;
  /** Optional normalized height (0–1) of a dragged region. */
  height?: number;
  /** The user's note describing what to change at this spot. */
  note: string;
  /** The preview URL the annotation was made against. */
  pageUrl: string;
}

// The wire codec (marker prefix + encode/parse) lives in the server (`src/team/protocol.ts`):
// this package is consumed unbuilt and stays strictly type-only with no runtime exports.
