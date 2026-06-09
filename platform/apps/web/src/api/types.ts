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

import type { PullRequestDto, ReviewCommentDto } from "@reload/shared";

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
  createdAt: string;
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
  | { type: "error"; code: "forbidden" | "bad_request" | "not_found"; detail?: string }
  | { type: "pong" };
