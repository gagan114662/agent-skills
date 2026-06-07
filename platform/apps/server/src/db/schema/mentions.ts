import { pgTable, uuid, timestamp, index, unique } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { messages } from "./messages.js";
import { members } from "./identities.js";

/**
 * @mentions extracted from a message body at post time (issue #6, ADR-0006). The message is
 * the source of truth; a mention row is derived per resolved member. `workspace_id` +
 * `channel_id` are denormalized so "my mentions" and mention counts are single-table,
 * workspace-scoped reads. UNIQUE(message_id, mentioned_member_id) makes extraction idempotent.
 */
export const messageMentions = pgTable(
  "message_mentions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    mentionedMemberId: uuid("mentioned_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    authorMemberId: uuid("author_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byMember: index("message_mentions_member_idx").on(t.mentionedMemberId, t.createdAt),
    messageMemberUniq: unique("message_mentions_uniq").on(t.messageId, t.mentionedMemberId),
  }),
);
