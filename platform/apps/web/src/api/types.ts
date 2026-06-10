/**
 * Wire types for the Reload web client — a hand-mirrored copy of the server's REST + WebSocket
 * contract (see `platform/.context/api-contract.md`). The server does not export these from
 * `@reload/shared` (only the health types live there), so we keep a typed, documented copy here.
 *
 * Field-name landmines preserved deliberately (they differ from intuition):
 *  - message text is `body` (not `content`/`text`)
 *  - thread parent is `parentMessageId` (not `threadId`/`parentId`)
 *  - author is `authorMemberId` (a *member* id), and a message carries NO display name / timestamp
 *  - identity carries `kind: "human" | "agent"` (there is no `isAgent` boolean)
 */

import type { DeployStatus, PullRequestDto, ReviewCommentDto, RunStatus } from "@reload/shared";

export type MemberKind = "human" | "agent";
export type ChannelKind = "public" | "dm";
export type PresenceStatus = "online" | "away" | "offline";

/** Current caller, from `GET /me`. */
export interface Identity {
  workspaceId: string;
  memberId: string;
  kind: MemberKind;
  displayName: string;
}

/** A channel, from `GET/POST /workspaces/:wid/channels` and `/dms`. */
export interface Channel {
  id: string;
  workspaceId: string;
  kind: ChannelKind;
  name: string | null;
  isArchived: boolean;
}

/** A message — REST list/create payload AND the realtime `message` event payload. */
export interface Message {
  id: string;
  channelId: string;
  authorMemberId: string;
  parentMessageId: string | null;
  alsoSentToChannel: boolean;
  body: string;
}

/** Thread view, from `GET /channels/:cid/messages/:mid/thread`. */
export interface ThreadView {
  root: Message;
  replies: Message[];
  replyCount: number;
}

/** A persisted mention row, from `GET /me/mentions`. */
export interface MentionItem {
  id: string;
  messageId: string;
  channelId: string;
  authorMemberId: string;
  body: string;
  createdAt: string;
}

/** A realtime mention event payload (no `createdAt`). */
export interface MentionEvent {
  id: string;
  messageId: string;
  channelId: string;
  mentionedMemberId: string;
  authorMemberId: string;
  body: string;
}

/**
 * A notification pushed to the recipient's sockets (#8) — mirrors the server `NotificationEvent`
 * (`apps/server/src/realtime/protocol.ts`). Delivered to the recipient regardless of channel
 * subscription. `type:"approval"` is the signal a gated action (#13) needs a human decision; the
 * Approvals Panel uses it to refresh the pending queue live. The server already emits this event —
 * the web union simply never listed it (see ADR-0026).
 */
export interface NotificationEvent {
  id: string;
  type: "mention" | "dm" | "reply" | "assignment" | "approval";
  recipientMemberId: string;
  actorMemberId: string | null;
  channelId: string | null;
  messageId: string | null;
  taskId: string | null;
  excerpt: string | null;
  createdAt: string;
}

/** A member search hit, from `GET /workspaces/:wid/search/members`. */
export interface MemberHit {
  id: string;
  kind: MemberKind;
  displayName: string;
}

/** An agent profile, from `GET /workspaces/:wid/agents`. */
export interface AgentProfile {
  id: string;
  name: string;
  framework: string | null;
  ownerUserId: string | null;
  deactivatedAt: string | null;
  createdAt: string;
}

/**
 * A summary of an agent session for the review surface (#51), from `GET /channels/:cid/agent-sessions`.
 * The git refs are set once the session has run in a worktree (null otherwise).
 */
export interface AgentSessionSummary {
  id: string;
  channelId: string;
  agentMemberId: string;
  status: string;
  result: string | null;
  branch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  /** Model/provider selection (#52) the session ran with; null when none was chosen. */
  provider: ProviderKind | null;
  model: string | null;
  effort: EffortLevel | null;
  mode: SessionMode | null;
  createdAt: string;
}

/** Model/provider selection vocabulary (#52) — mirrors the server's selection layer. */
export type ProviderKind = "anthropic" | "openai" | "bedrock" | "vertex" | "custom";
export type EffortLevel = "off" | "low" | "medium" | "high";
export type SessionMode = "single" | "auto";

/** A per-session model/provider selection a launch form collects (#52). */
export interface ModelSelection {
  provider: ProviderKind;
  model: string;
  effort: EffortLevel;
  mode: SessionMode;
}

/** Search envelope shared by all three search endpoints. */
export interface SearchEnvelope<T> {
  query: string;
  limit: number;
  offset: number;
  results: T[];
}

// --- WebSocket protocol (mirrors apps/server/src/realtime/protocol.ts) ----------------------

/** Commands the client sends to the `/ws` gateway. */
export type ClientCommand =
  | { type: "subscribe"; channelId: string }
  | { type: "unsubscribe"; channelId: string }
  | { type: "presence"; status: "online" | "away" }
  | { type: "ping" };

/** Cloud-scale usage report (#71), from `GET /workspaces/:wid/scale/usage`. */
export interface UsageReport {
  /** The billing window (UTC `YYYY-MM`). */
  window: string;
  sessionsStarted: number;
  computeSeconds: number;
  estimatedCostCents: number;
  /** The resolved caps/budget for this tenant (0 = off/unlimited). */
  caps: {
    tenantConcurrency: number;
    budgetCents: number;
    warmPoolSize: number;
    regions: string[];
  };
  /** Live in-flight concurrency: this tenant, the whole fleet, and per region. */
  inFlight: {
    tenant: number;
    global: number;
    byRegion: Record<string, number>;
  };
  /** True when accrued cost has met/passed the budget cap (new launches are halted). */
  overBudget: boolean;
}

/**
 * The Founder Console roll-up (#104), from `GET /workspaces/:wid/founder-console`. A read-only
 * aggregation: fleet status, the venture pipeline (#96), revenue/willingness-to-pay (#98), budget
 * burn (#71), the pending #13 approval queue (with decision-SLA ages), and the safety switches.
 * Mirrors the server `FounderConsole` shape (kept in lock-step by hand — no codegen).
 */
export interface FounderConsoleDto {
  workspaceId: string;
  generatedAtMs: number;
  fleet: { activeSessions: number; sessionsThisWindow: number; globalInFlight: number };
  venturePipeline: {
    total: number;
    active: number;
    funded: number;
    killed: number;
    /** Borderline calls awaiting human judgment (terminal verdict ESCALATE). */
    escalated: number;
  };
  revenue: {
    currency: string;
    totalCents: number;
    paymentCount: number;
    willingnessToPayCount: number;
    hasWillingnessToPay: boolean;
  };
  budget: {
    window: string;
    estimatedCostCents: number;
    budgetCents: number;
    overBudget: boolean;
    /** Spent / cap as a fraction; null when no positive cap is set. */
    utilization: number | null;
  };
  /** The pending #13 queue, oldest-first (longest-waiting = highest priority). */
  pendingApprovals: {
    id: string;
    actionType: string;
    summary: string;
    amount: number | null;
    /** Time in queue, in seconds (the decision SLA). */
    ageSeconds: number;
    createdAtMs: number;
  }[];
  switches: {
    killSwitch: boolean;
    maintenance: { enabled: boolean; since?: string; reason?: string; unavailable?: boolean };
  };
  /** Whether the platform needs a human right now, and why. */
  attention: { required: boolean; reasons: string[] };
}

/** Events the `/ws` gateway sends to the client. */
export type ServerEvent =
  | { type: "ready"; memberId: string; workspaceId: string }
  | { type: "subscribed"; channelId: string }
  | { type: "unsubscribed"; channelId: string }
  | { type: "message"; message: Message }
  | { type: "mention"; mention: MentionEvent }
  | { type: "notification"; notification: NotificationEvent }
  | { type: "presence"; memberId: string; status: PresenceStatus }
  | { type: "pull_request"; pullRequest: PullRequestDto }
  | { type: "review_comment"; comment: ReviewCommentDto }
  | {
      type: "run_status";
      sessionId: string;
      channelId: string;
      status: RunStatus;
      url?: string | null;
      exitCode?: number | null;
      error?: string | null;
    }
  | { type: "run_log"; sessionId: string; channelId: string; chunk: string }
  | {
      type: "deploy_status";
      sessionId: string;
      channelId: string;
      deploymentId: string;
      status: DeployStatus;
      url?: string | null;
      error?: string | null;
    }
  | { type: "deploy_log"; sessionId: string; channelId: string; deploymentId: string; chunk: string }
  | { type: "error"; code: "forbidden" | "bad_request" | "not_found"; detail?: string }
  | { type: "pong" };
