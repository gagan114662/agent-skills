import type { PullRequestDto, ReviewCommentDto, TeamEvent } from "@reload/shared";
import { getRedis } from "../redis/index.js";
import type { Message } from "../db/repositories/messages.js";
import type {
  MentionEvent,
  NotificationEvent,
  PresenceStatus,
  ServerEvent,
  WorkspacePresenceEvent,
} from "./protocol.js";

/**
 * Redis pub/sub fan-out for realtime delivery (#5). REST is the source of truth; these
 * helpers publish-on-write so a message/presence change reaches subscribers connected to
 * *any* server instance. The gateway `PSUBSCRIBE`s the matching key patterns.
 */

export const CHANNEL_KEY_PREFIX = "rt:channel:";
export const PRESENCE_KEY_PREFIX = "rt:presence:";
export const MENTION_KEY_PREFIX = "rt:mention:";
export const NOTIFY_KEY_PREFIX = "rt:notify:";
export const CLOUD_WS_KEY_PREFIX = "rt:cloudws:";

/** Pattern the gateway subscribes to for all channel-message fan-out. */
export const CHANNEL_PATTERN = `${CHANNEL_KEY_PREFIX}*`;
/** Pattern the gateway subscribes to for all presence fan-out. */
export const PRESENCE_PATTERN = `${PRESENCE_KEY_PREFIX}*`;
/** Pattern the gateway subscribes to for all mention fan-out (#6). */
export const MENTION_PATTERN = `${MENTION_KEY_PREFIX}*`;
/** Pattern the gateway subscribes to for all notification fan-out (#8). */
export const NOTIFY_PATTERN = `${NOTIFY_KEY_PREFIX}*`;
/** Pattern the gateway subscribes to for shared cloud workspace presence + revoke (#55). */
export const CLOUD_WS_PATTERN = `${CLOUD_WS_KEY_PREFIX}*`;

/** Redis pub/sub key carrying message events for one channel. */
export function channelKey(channelId: string): string {
  return `${CHANNEL_KEY_PREFIX}${channelId}`;
}

/** Redis pub/sub key carrying presence events for one workspace. */
export function presenceKey(workspaceId: string): string {
  return `${PRESENCE_KEY_PREFIX}${workspaceId}`;
}

/** Redis pub/sub key carrying mention events for one workspace (#6). */
export function mentionKey(workspaceId: string): string {
  return `${MENTION_KEY_PREFIX}${workspaceId}`;
}

/** Redis pub/sub key carrying notification events for one workspace (#8). */
export function notifyKey(workspaceId: string): string {
  return `${NOTIFY_KEY_PREFIX}${workspaceId}`;
}

/** Recover the channel id from a `rt:channel:<id>` key. */
export function channelIdFromKey(key: string): string | null {
  return key.startsWith(CHANNEL_KEY_PREFIX) ? key.slice(CHANNEL_KEY_PREFIX.length) : null;
}

/** Recover the workspace id from a `rt:presence:<id>` key. */
export function workspaceIdFromPresenceKey(key: string): string | null {
  return key.startsWith(PRESENCE_KEY_PREFIX) ? key.slice(PRESENCE_KEY_PREFIX.length) : null;
}

/** Recover the workspace id from a `rt:mention:<id>` key. */
export function workspaceIdFromMentionKey(key: string): string | null {
  return key.startsWith(MENTION_KEY_PREFIX) ? key.slice(MENTION_KEY_PREFIX.length) : null;
}

/** Recover the workspace id from a `rt:notify:<id>` key. */
export function workspaceIdFromNotifyKey(key: string): string | null {
  return key.startsWith(NOTIFY_KEY_PREFIX) ? key.slice(NOTIFY_KEY_PREFIX.length) : null;
}

/** Redis pub/sub key carrying presence + access-revoke events for one cloud workspace (#55). */
export function cloudWorkspaceKey(cloudWorkspaceId: string): string {
  return `${CLOUD_WS_KEY_PREFIX}${cloudWorkspaceId}`;
}

/** Recover the cloud workspace id from a `rt:cloudws:<id>` key. */
export function cloudWorkspaceIdFromKey(key: string): string | null {
  return key.startsWith(CLOUD_WS_KEY_PREFIX) ? key.slice(CLOUD_WS_KEY_PREFIX.length) : null;
}

/** Publish a newly-posted message to its channel's subscribers (called by the REST route). */
export async function publishMessageEvent(channelId: string, message: Message): Promise<void> {
  const event: ServerEvent = { type: "message", message };
  await getRedis().publish(channelKey(channelId), JSON.stringify(event));
}

/**
 * Publish a team event to its channel's subscribers (Team Mode). Rides the same `rt:channel:<id>`
 * key as ordinary messages — the message carrying the event is already persisted (REST source of
 * truth), so this is a best-effort live nudge and needs no new gateway pattern.
 */
export async function publishTeamEvent(channelId: string, event: TeamEvent): Promise<void> {
  const serverEvent: ServerEvent = { type: "team_event", event };
  await getRedis().publish(channelKey(channelId), JSON.stringify(serverEvent));
}

/**
 * Publish a pull-request change to its channel's subscribers (#51). Rides the same `rt:channel:<id>`
 * key as messages — the PR row is already persisted (REST source of truth), so this is a best-effort
 * live nudge that needs no new gateway pattern.
 */
export async function publishPullRequestEvent(
  channelId: string,
  pullRequest: PullRequestDto,
): Promise<void> {
  const event: ServerEvent = { type: "pull_request", pullRequest };
  await getRedis().publish(channelKey(channelId), JSON.stringify(event));
}

/** Publish a new/updated review comment to its channel's subscribers (#51). */
export async function publishReviewCommentEvent(
  channelId: string,
  comment: ReviewCommentDto,
): Promise<void> {
  const event: ServerEvent = { type: "review_comment", comment };
  await getRedis().publish(channelKey(channelId), JSON.stringify(event));
}

/**
 * Publish a mention to the workspace stream (#6). The gateway delivers it only to the
 * mentioned member's sockets (human or agent), independent of channel subscription.
 */
export async function publishMention(workspaceId: string, mention: MentionEvent): Promise<void> {
  const event: ServerEvent = { type: "mention", mention };
  await getRedis().publish(mentionKey(workspaceId), JSON.stringify(event));
}

/**
 * Publish a notification to the workspace stream (#8). The gateway delivers it only to the
 * recipient member's sockets (human or agent), independent of channel subscription.
 */
export async function publishNotification(
  workspaceId: string,
  notification: NotificationEvent,
): Promise<void> {
  const event: ServerEvent = { type: "notification", notification };
  await getRedis().publish(notifyKey(workspaceId), JSON.stringify(event));
}

/** Publish a presence change to everyone in the workspace. */
export async function publishPresence(
  workspaceId: string,
  memberId: string,
  status: PresenceStatus,
): Promise<void> {
  const event: ServerEvent = { type: "presence", memberId, status };
  await getRedis().publish(presenceKey(workspaceId), JSON.stringify(event));
}

/** Redis hash holding current presence for a workspace (`memberId` → status). */
export function presenceHashKey(workspaceId: string): string {
  return `presence:${workspaceId}`;
}

/** Publish a shared-workspace presence change (joined/left) to its watchers (#55). */
export async function publishWorkspacePresence(
  presence: WorkspacePresenceEvent,
): Promise<void> {
  const event: ServerEvent = { type: "workspace_presence", presence };
  await getRedis().publish(cloudWorkspaceKey(presence.cloudWorkspaceId), JSON.stringify(event));
}

/**
 * Publish an access-revoked signal for a cloud workspace, targeted at one member (#55). The
 * gateway drops that member's live watch and tells them — so revoke cuts access in real time.
 */
export async function publishAccessRevoked(
  cloudWorkspaceId: string,
  memberId: string,
): Promise<void> {
  const event = { type: "access_revoked" as const, cloudWorkspaceId, memberId };
  await getRedis().publish(cloudWorkspaceKey(cloudWorkspaceId), JSON.stringify(event));
}
