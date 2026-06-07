import { and, desc, eq, count, isNull, sql } from "drizzle-orm";
import { db } from "../index.js";
import { notifications, notificationPreferences } from "../schema/index.js";
import {
  DEFAULT_PREFS,
  type NotificationPrefs,
  type NotificationType,
} from "../../notifications/types.js";

/** A notification as carried in the inbox (REST) and the realtime `notification` event. */
export interface Notification {
  id: string;
  workspaceId: string;
  recipientMemberId: string;
  type: NotificationType;
  actorMemberId: string | null;
  channelId: string | null;
  messageId: string | null;
  taskId: string | null;
  excerpt: string | null;
  readAt: Date | null;
  createdAt: Date;
}

const COLUMNS = {
  id: notifications.id,
  workspaceId: notifications.workspaceId,
  recipientMemberId: notifications.recipientMemberId,
  type: notifications.type,
  actorMemberId: notifications.actorMemberId,
  channelId: notifications.channelId,
  messageId: notifications.messageId,
  taskId: notifications.taskId,
  excerpt: notifications.excerpt,
  readAt: notifications.readAt,
  createdAt: notifications.createdAt,
} as const;

/** Persist one notification row (the caller has already applied the preference gate). */
export async function createNotification(input: {
  workspaceId: string;
  recipientMemberId: string;
  type: NotificationType;
  actorMemberId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  taskId?: string | null;
  excerpt?: string | null;
}): Promise<Notification> {
  const [row] = await db
    .insert(notifications)
    .values({
      workspaceId: input.workspaceId,
      recipientMemberId: input.recipientMemberId,
      type: input.type,
      actorMemberId: input.actorMemberId ?? null,
      channelId: input.channelId ?? null,
      messageId: input.messageId ?? null,
      taskId: input.taskId ?? null,
      excerpt: input.excerpt ?? null,
    })
    .returning(COLUMNS);
  return row as Notification;
}

/** A member's notifications, newest first; `unreadOnly` filters to unread. Workspace-scoped. */
export async function listNotificationsForMember(
  workspaceId: string,
  memberId: string,
  opts: { unreadOnly?: boolean } = {},
): Promise<Notification[]> {
  const where = [
    eq(notifications.workspaceId, workspaceId),
    eq(notifications.recipientMemberId, memberId),
  ];
  if (opts.unreadOnly) where.push(isNull(notifications.readAt));
  const rows = await db
    .select(COLUMNS)
    .from(notifications)
    .where(and(...where))
    .orderBy(desc(notifications.createdAt));
  return rows as Notification[];
}

/** How many unread notifications a member has in their workspace. */
export async function countUnread(workspaceId: string, memberId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.recipientMemberId, memberId),
        isNull(notifications.readAt),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Mark one notification read. Scoped to (workspace, recipient) so a member can only ever mark
 * their own — a notification belonging to someone else (or another workspace) is untouched and
 * returns false → the route answers 404 (the #3 IDOR guard). Idempotent: an already-read
 * notification stays read and still returns true.
 */
export async function markRead(
  workspaceId: string,
  memberId: string,
  notificationId: string,
): Promise<boolean> {
  const updated = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.recipientMemberId, memberId),
      ),
    )
    .returning({ id: notifications.id });
  return updated.length > 0;
}

/** Mark all of a member's unread notifications read; returns how many were marked. */
export async function markAllRead(workspaceId: string, memberId: string): Promise<number> {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.recipientMemberId, memberId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  return updated.length;
}

/** A member's preferences, or the defaults (everything delivered) when no row exists. */
export async function getPreferences(memberId: string): Promise<NotificationPrefs> {
  const [row] = await db
    .select({
      muted: notificationPreferences.muted,
      mentionOnly: notificationPreferences.mentionOnly,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.memberId, memberId))
    .limit(1);
  return row ?? DEFAULT_PREFS;
}

/** Upsert a member's preferences (partial patch merged over the current values). */
export async function upsertPreferences(
  workspaceId: string,
  memberId: string,
  patch: { muted?: boolean; mentionOnly?: boolean },
): Promise<NotificationPrefs> {
  const current = await getPreferences(memberId);
  const next: NotificationPrefs = {
    muted: patch.muted ?? current.muted,
    mentionOnly: patch.mentionOnly ?? current.mentionOnly,
  };
  await db
    .insert(notificationPreferences)
    .values({ memberId, workspaceId, muted: next.muted, mentionOnly: next.mentionOnly })
    .onConflictDoUpdate({
      target: notificationPreferences.memberId,
      set: { muted: next.muted, mentionOnly: next.mentionOnly, updatedAt: new Date() },
    });
  return next;
}
