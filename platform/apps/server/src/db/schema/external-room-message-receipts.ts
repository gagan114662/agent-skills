import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { channels } from "./channels.js";
import { messages } from "./messages.js";
import { workspaces } from "./workspaces.js";

export const EXTERNAL_ROOM_MESSAGE_PROVIDERS = ["telegram", "whatsapp"] as const;
export const EXTERNAL_ROOM_MESSAGE_DIRECTIONS = ["outbound", "inbound"] as const;

/** Provider-native ids for room messages, used to correlate external replies without visible receipt text. */
export const externalRoomMessageReceipts = pgTable(
  "external_room_message_receipts",
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
    provider: text("provider", { enum: EXTERNAL_ROOM_MESSAGE_PROVIDERS }).notNull(),
    providerConversationId: text("provider_conversation_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    direction: text("direction", { enum: EXTERNAL_ROOM_MESSAGE_DIRECTIONS }).notNull().default("outbound"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerMessageUnique: uniqueIndex("external_room_message_receipts_provider_message_uidx").on(
      t.provider,
      t.providerConversationId,
      t.providerMessageId,
    ),
    byMessage: index("external_room_message_receipts_message_idx").on(t.messageId),
    byWorkspace: index("external_room_message_receipts_workspace_idx").on(t.workspaceId, t.createdAt),
    byWorkspaceProviderDirection: index("external_room_message_receipts_readiness_idx").on(
      t.workspaceId,
      t.provider,
      t.direction,
      t.createdAt,
    ),
    providerCk: check("external_room_message_receipts_provider_ck", sql`${t.provider} IN ('telegram','whatsapp')`),
    directionCk: check("external_room_message_receipts_direction_ck", sql`${t.direction} IN ('outbound','inbound')`),
  }),
);
