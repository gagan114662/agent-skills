import type { PullRequestDto, ReviewCommentDto, TeamEvent } from "@reload/shared";
import type { Message } from "../db/repositories/messages.js";

/** Presence states a member can be in within a workspace (#5). */
export type PresenceStatus = "online" | "away" | "offline";

/**
 * A mention pushed to the mentioned member over the socket (#6). For an agent this is an
 * actionable event — it can act the instant it lands, without watching the channel.
 */
export interface MentionEvent {
  id: string;
  messageId: string;
  channelId: string;
  mentionedMemberId: string;
  authorMemberId: string;
  body: string;
}

/**
 * A notification pushed to the recipient's sockets (#8). Delivered to the recipient regardless of
 * channel subscription (like a #6 mention). `type` discriminates the activity (mention / dm /
 * reply / assignment); the reference ids + excerpt let a client render the inbox item live.
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

/** Commands a client sends to the gateway over the socket. */
export type ClientCommand =
  | { type: "subscribe"; channelId: string }
  | { type: "unsubscribe"; channelId: string }
  | { type: "presence"; status: "online" | "away" }
  | { type: "ping" };

/** Events the gateway pushes to a client. Discriminated by `type`. */
export type ServerEvent =
  | { type: "ready"; memberId: string; workspaceId: string }
  | { type: "subscribed"; channelId: string }
  | { type: "unsubscribed"; channelId: string }
  | { type: "message"; message: Message }
  | { type: "mention"; mention: MentionEvent }
  | { type: "notification"; notification: NotificationEvent }
  | { type: "presence"; memberId: string; status: PresenceStatus }
  | { type: "team_event"; event: TeamEvent }
  | { type: "pull_request"; pullRequest: PullRequestDto }
  | { type: "review_comment"; comment: ReviewCommentDto }
  | { type: "error"; code: "forbidden" | "bad_request" | "not_found"; detail?: string }
  | { type: "pong" };

/**
 * Parse a raw socket frame into a known client command, or return null for anything
 * malformed or unrecognized (the gateway replies with a `bad_request` error). Pure and
 * unit-testable — never throws, so a hostile client can't crash the connection handler.
 */
export function parseClientCommand(raw: string): ClientCommand | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;

  switch (obj.type) {
    case "subscribe":
    case "unsubscribe":
      return typeof obj.channelId === "string" && obj.channelId.length > 0
        ? { type: obj.type, channelId: obj.channelId }
        : null;
    case "presence":
      return obj.status === "online" || obj.status === "away"
        ? { type: "presence", status: obj.status }
        : null;
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}

/** Serialize a server event for transmission. */
export function encodeEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}
