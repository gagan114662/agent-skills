import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { channels } from "./channels.js";
import { members } from "./identities.js";
import { messages } from "./messages.js";
import { workspaces } from "./workspaces.js";

/** Per-member Apple Messages destination. Pending rows are not treated as connected until a real send works. */
export const imessageRecipients = pgTable(
  "imessage_recipients",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    recipient: text("recipient").notNull(),
    serviceName: text("service_name"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    memberUnique: uniqueIndex("imessage_recipients_member_uidx").on(t.workspaceId, t.memberId),
  }),
);

export const IMESSAGE_RELAY_JOB_PURPOSES = ["verification", "room", "notification"] as const;
export const IMESSAGE_RELAY_JOB_STATUSES = ["pending", "claimed", "sent", "failed"] as const;
export const IMESSAGE_RELAY_MESSAGES_ACCESS_STATUSES = ["unknown", "ok", "failed"] as const;
export const IMESSAGE_RELAY_MESSAGES_DB_ACCESS_STATUSES = ["unknown", "ok", "failed"] as const;

/** Durable outbound queue for a signed Mac Messages relay worker (#1341). */
export const imessageRelayJobs = pgTable(
  "imessage_relay_jobs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").references(() => members.id, { onDelete: "set null" }),
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "set null" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    purpose: text("purpose", { enum: IMESSAGE_RELAY_JOB_PURPOSES }).notNull(),
    recipient: text("recipient").notNull(),
    serviceName: text("service_name"),
    body: text("body").notNull(),
    receipt: text("receipt"),
    status: text("status", { enum: IMESSAGE_RELAY_JOB_STATUSES }).notNull().default("pending"),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCreated: index("imessage_relay_jobs_status_created_idx").on(t.status, t.createdAt),
    workspaceCreated: index("imessage_relay_jobs_workspace_idx").on(t.workspaceId, t.createdAt),
    purposeCk: check("imessage_relay_jobs_purpose_ck", sql`${t.purpose} IN ('verification','room','notification')`),
    statusCk: check("imessage_relay_jobs_status_ck", sql`${t.status} IN ('pending','claimed','sent','failed')`),
  }),
);

/** Last-seen heartbeat for signed Mac relay workers. This proves a host is online without exposing secrets. */
export const imessageRelayHeartbeats = pgTable(
  "imessage_relay_heartbeats",
  {
    relayId: text("relay_id").primaryKey(),
    host: text("host").notNull(),
    version: text("version"),
    messagesAccess: text("messages_access", { enum: IMESSAGE_RELAY_MESSAGES_ACCESS_STATUSES }).notNull().default("unknown"),
    messagesDbAccess: text("messages_db_access", { enum: IMESSAGE_RELAY_MESSAGES_DB_ACCESS_STATUSES })
      .notNull()
      .default("unknown"),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    checkedIn: index("imessage_relay_heartbeats_checked_in_idx").on(t.checkedInAt),
    messagesAccessCk: check(
      "imessage_relay_heartbeats_messages_access_ck",
      sql`${t.messagesAccess} IN ('unknown','ok','failed')`,
    ),
    messagesDbAccessCk: check(
      "imessage_relay_heartbeats_messages_db_access_ck",
      sql`${t.messagesDbAccess} IN ('unknown','ok','failed')`,
    ),
  }),
);

/** Inbound replies accepted from the signed Mac relay, used for owner-visible loop proof. */
export const imessageRelayInboundReceipts = pgTable(
  "imessage_relay_inbound_receipts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    replyToMessageId: uuid("reply_to_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    sender: text("sender").notNull(),
    receipt: text("receipt").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceCreated: index("imessage_relay_inbound_receipts_workspace_idx").on(t.workspaceId, t.createdAt),
    memberCreated: index("imessage_relay_inbound_receipts_member_idx").on(t.workspaceId, t.memberId, t.createdAt),
    messageUnique: uniqueIndex("imessage_relay_inbound_receipts_message_uidx").on(t.messageId),
  }),
);
