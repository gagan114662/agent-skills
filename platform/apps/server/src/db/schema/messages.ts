import { pgTable, uuid, text, timestamp, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { members } from "./identities.js";

/** Chat messages. Threads via self-referencing parent_message_id; soft-delete via deleted_at. */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    authorMemberId: uuid("author_member_id")
      .notNull()
      .references(() => members.id),
    parentMessageId: uuid("parent_message_id").references((): AnyPgColumn => messages.id, {
      onDelete: "cascade",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    byChannel: index("messages_channel_created_idx").on(t.channelId, t.createdAt),
    byParent: index("messages_parent_idx").on(t.parentMessageId),
  }),
);
