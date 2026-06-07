import { getRedis } from "../redis/index.js";
import type { Message } from "../db/repositories/messages.js";
import type { PresenceStatus, ServerEvent } from "./protocol.js";

/**
 * Redis pub/sub fan-out for realtime delivery (#5). REST is the source of truth; these
 * helpers publish-on-write so a message/presence change reaches subscribers connected to
 * *any* server instance. The gateway `PSUBSCRIBE`s the matching key patterns.
 */

export const CHANNEL_KEY_PREFIX = "rt:channel:";
export const PRESENCE_KEY_PREFIX = "rt:presence:";

/** Pattern the gateway subscribes to for all channel-message fan-out. */
export const CHANNEL_PATTERN = `${CHANNEL_KEY_PREFIX}*`;
/** Pattern the gateway subscribes to for all presence fan-out. */
export const PRESENCE_PATTERN = `${PRESENCE_KEY_PREFIX}*`;

/** Redis pub/sub key carrying message events for one channel. */
export function channelKey(channelId: string): string {
  return `${CHANNEL_KEY_PREFIX}${channelId}`;
}

/** Redis pub/sub key carrying presence events for one workspace. */
export function presenceKey(workspaceId: string): string {
  return `${PRESENCE_KEY_PREFIX}${workspaceId}`;
}

/** Recover the channel id from a `rt:channel:<id>` key. */
export function channelIdFromKey(key: string): string | null {
  return key.startsWith(CHANNEL_KEY_PREFIX) ? key.slice(CHANNEL_KEY_PREFIX.length) : null;
}

/** Recover the workspace id from a `rt:presence:<id>` key. */
export function workspaceIdFromPresenceKey(key: string): string | null {
  return key.startsWith(PRESENCE_KEY_PREFIX) ? key.slice(PRESENCE_KEY_PREFIX.length) : null;
}

/** Publish a newly-posted message to its channel's subscribers (called by the REST route). */
export async function publishMessageEvent(channelId: string, message: Message): Promise<void> {
  const event: ServerEvent = { type: "message", message };
  await getRedis().publish(channelKey(channelId), JSON.stringify(event));
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
