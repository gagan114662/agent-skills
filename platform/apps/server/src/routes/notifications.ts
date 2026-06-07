import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import {
  listNotificationsForMember,
  countUnread,
  markRead,
  markAllRead,
  getPreferences,
  upsertPreferences,
} from "../db/repositories/notifications.js";

/**
 * Notification inbox + preferences (issue #8). Every endpoint is scoped to the caller
 * (`identity.memberId`) within their workspace (`identity.workspaceId`) — the recipient is always
 * the caller, so a member can only ever see/modify their own notifications (the #3 IDOR guard).
 */
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  // The caller's notifications, newest first; ?unread=true filters to unread only.
  app.get("/me/notifications", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const q = req.query as { unread?: string };
    const unreadOnly = q.unread === "true" || q.unread === "1";
    return listNotificationsForMember(id.workspaceId, id.memberId, { unreadOnly });
  });

  // The caller's unread count.
  app.get("/me/notifications/unread-count", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return { count: await countUnread(id.workspaceId, id.memberId) };
  });

  // Mark one notification read (404 if it isn't the caller's). Idempotent.
  app.post("/me/notifications/:nid/read", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { nid } = req.params as { nid: string };
    const ok = await markRead(id.workspaceId, id.memberId, nid);
    if (!ok) return reply.code(404).send({ error: "notification not found" });
    return { ok: true };
  });

  // Mark all of the caller's unread notifications read.
  app.post("/me/notifications/read-all", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return { marked: await markAllRead(id.workspaceId, id.memberId) };
  });

  // The caller's notification preferences (defaults when none set).
  app.get("/me/notification-preferences", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return getPreferences(id.memberId);
  });

  // Upsert the caller's preferences. Body: { muted?, mentionOnly? } (partial patch).
  app.put("/me/notification-preferences", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const b = req.body as { muted?: unknown; mentionOnly?: unknown };
    const patch: { muted?: boolean; mentionOnly?: boolean } = {};
    if ("muted" in b) {
      if (typeof b.muted !== "boolean") return reply.code(400).send({ error: "muted must be a boolean" });
      patch.muted = b.muted;
    }
    if ("mentionOnly" in b) {
      if (typeof b.mentionOnly !== "boolean") {
        return reply.code(400).send({ error: "mentionOnly must be a boolean" });
      }
      patch.mentionOnly = b.mentionOnly;
    }
    return upsertPreferences(id.workspaceId, id.memberId, patch);
  });
}
