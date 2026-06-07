import { pgTable, uuid, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { messages } from "./messages.js";
import { tasks } from "./tasks.js";
import { members } from "./identities.js";

/**
 * Notifications inbox (issue #8, ADR-0008). One row per recipient per activity (mention / dm /
 * reply / assignment; `approval` reserved). `workspace_id` + the reference columns are
 * denormalized so the inbox and unread count are single-table, workspace- and recipient-scoped
 * reads; `excerpt` is a snapshot so the inbox renders without joins and survives source deletion.
 * `read_at IS NULL` ⇔ unread.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recipientMemberId: uuid("recipient_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actorMemberId: uuid("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    excerpt: text("excerpt"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRecipient: index("notifications_recipient_idx").on(t.recipientMemberId, t.createdAt),
    unread: index("notifications_unread_idx")
      .on(t.recipientMemberId)
      .where(sql`read_at IS NULL`),
  }),
);

/**
 * Per-member notification preferences (issue #8). `muted` silences all notifications;
 * `mentionOnly` keeps only `mention` notifications. A member belongs to exactly one workspace,
 * so `member_id` is the natural key; `workspace_id` is denormalized for scoped consistency.
 */
export const notificationPreferences = pgTable("notification_preferences", {
  memberId: uuid("member_id")
    .primaryKey()
    .references(() => members.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  muted: boolean("muted").notNull().default(false),
  mentionOnly: boolean("mention_only").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
