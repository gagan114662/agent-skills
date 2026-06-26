/**
 * The notify service (issue #8): the single seam every trigger calls. It composes the pieces —
 * preference gate → persist → realtime publish → external transport — and is **best-effort**: it
 * never throws, so a Redis/DB/webhook hiccup is logged but never fails the REST write that already
 * succeeded (the same publish-on-write discipline as #5/#6, ADR-0008). Repositories stay pure DB;
 * this is where the cross-cutting fan-out lives.
 */
import type { FastifyBaseLogger } from "fastify";
import {
  createNotification,
  getPreferences,
  type Notification,
} from "../db/repositories/notifications.js";
import { publishNotification } from "../realtime/bus.js";
import type { NotificationEvent } from "../realtime/protocol.js";
import { loadEnv } from "../env.js";
import { loadConfig } from "../config/loader.js";
import { createIMessageRelayService } from "../imessage/default.js";
import { IMessageNotificationTransport } from "../imessage/notification-transport.js";
import { shouldNotify, type NotificationType } from "./types.js";
import {
  FanoutTransport,
  selectTransport,
  type NotificationRecord,
  type NotificationTransport,
} from "./transport.js";

export interface NotifyInput {
  workspaceId: string;
  recipientMemberId: string;
  type: NotificationType;
  actorMemberId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  taskId?: string | null;
  excerpt?: string | null;
}

let transport: NotificationTransport | undefined;

/** The deployment's external transport, chosen once from env (webhook when configured, else no-op). */
function getNotificationTransport(): NotificationTransport {
  // #58: data-privacy mode (server-level managed config) forces the no-op transport regardless of URL.
  if (!transport) {
    const env = loadEnv();
    const base = selectTransport(env.notify.webhookUrl, {
      dataPrivacyMode: loadConfig().dataPrivacyMode,
    });
    transport = env.imessage.enabled
      ? new FanoutTransport([base, new IMessageNotificationTransport(createIMessageRelayService(env.imessage))])
      : base;
  }
  return transport;
}

function toRecord(n: Notification): NotificationRecord {
  return {
    id: n.id,
    workspaceId: n.workspaceId,
    recipientMemberId: n.recipientMemberId,
    type: n.type,
    actorMemberId: n.actorMemberId,
    channelId: n.channelId,
    messageId: n.messageId,
    taskId: n.taskId,
    excerpt: n.excerpt,
    createdAt: n.createdAt.toISOString(),
  };
}

function toEvent(n: Notification): NotificationEvent {
  return {
    id: n.id,
    type: n.type,
    recipientMemberId: n.recipientMemberId,
    actorMemberId: n.actorMemberId,
    channelId: n.channelId,
    messageId: n.messageId,
    taskId: n.taskId,
    excerpt: n.excerpt,
    createdAt: n.createdAt.toISOString(),
  };
}

/**
 * Create a notification for the recipient (if their preferences allow it), push a realtime
 * `notification` event to their sockets, and forward it to the external transport. Returns the
 * persisted notification, or null when it was suppressed (preferences, or actor == recipient) or
 * an error occurred. Awaiting this guarantees the row is persisted + the WS event published before
 * the route responds; the external transport is fire-and-forget. Never throws.
 */
export async function notify(
  log: FastifyBaseLogger,
  input: NotifyInput,
): Promise<Notification | null> {
  try {
    // Never notify the actor about their own action (e.g. assigning a task to yourself).
    if (input.actorMemberId && input.actorMemberId === input.recipientMemberId) return null;

    const prefs = await getPreferences(input.recipientMemberId);
    if (!shouldNotify(input.type, prefs)) return null;

    const n = await createNotification(input);
    await publishNotification(n.workspaceId, toEvent(n)).catch((err) =>
      log.error({ err }, "notification publish failed"),
    );
    getNotificationTransport()
      .deliver(toRecord(n))
      .catch((err) => log.error({ err }, "notification transport failed"));
    return n;
  } catch (err) {
    log.error({ err }, "notify failed");
    return null;
  }
}
