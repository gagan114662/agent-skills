import { getRedis } from "../redis/index.js";
import { channelKey, mentionKey } from "../realtime/bus.js";
import type { MentionEvent, ServerEvent } from "../realtime/protocol.js";
import type { Message } from "../db/repositories/messages.js";

/**
 * The realtime source an MCP session subscribes to for resource-update pushes (#10). An MCP client
 * that `resources/subscribe`s to `reload://mentions` (or a channel) makes the server *just another
 * subscriber* on the existing #5 Redis pub/sub bus — REST is still the source of truth, MCP is a
 * second listener (ADR-0010 decision 5). It is an injected dependency so the unit test drives it
 * deterministically without Redis, and the Redis impl is lazy (a subscriber socket opens only when
 * an MCP client actually subscribes — non-subscribing/inject tests stay Redis-free).
 */
export type Unsubscribe = () => void;

export interface RealtimeSubscriptions {
  /** Push the caller's own @mentions (#6); filters the workspace mention stream to `memberId`. */
  subscribeMentions(
    workspaceId: string,
    memberId: string,
    onMention: (mention: MentionEvent) => void,
  ): Unsubscribe;
  /** Push new messages on one channel (#4/#5). */
  subscribeChannel(channelId: string, onMessage: (message: Message) => void): Unsubscribe;
}

/** Subscribe a freshly-duplicated Redis connection to one exact key; returns its teardown. */
function subscribeKey(key: string, onEvent: (event: ServerEvent) => void): Unsubscribe {
  const sub = getRedis().duplicate();
  sub.on("message", (_channel, payload) => {
    try {
      onEvent(JSON.parse(payload) as ServerEvent);
    } catch {
      /* a malformed frame must never crash the session */
    }
  });
  // lazyConnect is inherited from the shared client; subscribe() triggers the connect.
  void sub.subscribe(key).catch(() => {
    /* a Redis hiccup degrades live push to "no notifications", never throws into the session */
  });
  return () => {
    sub.disconnect();
  };
}

/** The production realtime bridge, backed by the #5 Redis bus. */
export const redisRealtimeSubscriptions: RealtimeSubscriptions = {
  subscribeMentions(workspaceId, memberId, onMention) {
    return subscribeKey(mentionKey(workspaceId), (event) => {
      if (event.type === "mention" && event.mention.mentionedMemberId === memberId) {
        onMention(event.mention);
      }
    });
  },
  subscribeChannel(channelId, onMessage) {
    return subscribeKey(channelKey(channelId), (event) => {
      if (event.type === "message") onMessage(event.message);
    });
  },
};
