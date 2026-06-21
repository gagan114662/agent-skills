import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import {
  OUTBOUND_CHANNELS,
  OUTBOUND_CHANNEL_STATUSES,
  OUTBOUND_RECEIPT_SOURCES,
} from "../../outbound-channel/constants.js";

// Re-export the pure vocabulary so existing `db/schema` consumers keep importing channel types from here.
export {
  OUTBOUND_CHANNELS,
  OUTBOUND_CHANNEL_STATUSES,
  OUTBOUND_RECEIPT_SOURCES,
} from "../../outbound-channel/constants.js";
export type {
  OutboundChannel,
  OutboundChannelStatus,
  OutboundReceiptSource,
} from "../../outbound-channel/constants.js";

/**
 * The outbound-channel connect + receipt ledger (issue #395 — revenue blocker #1: connect + enable ONE
 * real outbound channel). The fleet can today only touch its own site; to reach a stranger it needs ONE
 * connected, enabled sending channel with PROVEN delivery. This schema is the queryable truth for that:
 *
 *   - `outbound_channels`       — the per-workspace connect-once ledger: is the channel connected, by whom,
 *                                 from which sending identity. It holds NO secret — only a non-reversible
 *                                 credential fingerprint (proof of connection). The live credential itself
 *                                 (the Postmark server token) stays owner-gated in the deployment env /
 *                                 #192 vault and is read inline at the send site, never persisted here.
 *   - `outbound_send_receipts`  — the append-only #200 §3 readback receipts: the production-grounded proof
 *                                 that a real send reached a real inbox (a Postmark MessageID read back, or
 *                                 a live-URL probe), tied to the #13 approval that authorized the send.
 *
 * This complements, and does not duplicate, the #192 credential vault (`external_credentials`, which never
 * returns secrets and is not channel-typed) — it is the channel-level enablement + verified-delivery
 * surface the revenue-blocker dashboard reads.
 */

export const outboundChannels = pgTable(
  "outbound_channels",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The channel id (see {@link OUTBOUND_CHANNELS}). One row per (workspace, channel). */
    channel: text("channel", { enum: OUTBOUND_CHANNELS }).notNull(),
    /** The underlying provider (e.g. "postmark") — informational, mirrors the connection descriptor. */
    provider: text("provider").notNull(),
    status: text("status", { enum: OUTBOUND_CHANNEL_STATUSES }).notNull().default("pending"),
    /** The verified sending identity (the DKIM-signed From address). NOT a secret. */
    fromAddress: text("from_address"),
    /**
     * A non-reversible fingerprint of the connected credential (sha256 slice) — safe to persist and show
     * as proof a credential is connected, without ever storing the token itself. NULL until connected.
     */
    credentialFingerprint: text("credential_fingerprint"),
    /** The member who completed the connect-once step (the owner consent). */
    connectedByMemberId: uuid("connected_by_member_id"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceChannel: uniqueIndex("outbound_channels_workspace_channel_uk").on(t.workspaceId, t.channel),
  }),
);

export const outboundSendReceipts = pgTable(
  "outbound_send_receipts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: OUTBOUND_CHANNELS }).notNull(),
    /** The #13 approval request that authorized the send this receipt proves. */
    approvalRequestId: uuid("approval_request_id"),
    /** The recipient the send was addressed to (the inbox we are proving we reached). */
    recipient: text("recipient").notNull(),
    /** How reality was touched (see {@link OUTBOUND_RECEIPT_SOURCES}). */
    source: text("source", { enum: OUTBOUND_RECEIPT_SOURCES }).notNull(),
    /** The external reference observed in production: the ESP message id, or the live URL. */
    externalRef: text("external_ref").notNull(),
    /** For a `live_url` receipt: the HTTP status a real probe returned. */
    httpStatus: integer("http_status"),
    /**
     * Whether the receipt passed the #200 §3 predicate (`isExternalReceipt`) — i.e. it is a real,
     * production-grounded proof, not a self-reported claim. A row may exist as `false` to record an
     * UNVERIFIED attempt (no readback yet); only `true` rows clear the "reached a real inbox" bar.
     */
    verified: boolean("verified").notNull().default(false),
    /** Optional structured detail (the probe response / read-back row) for the audit trail. */
    detail: jsonb("detail"),
    /** ISO timestamp at which reality was observed (passed in by the caller; never read from a clock here). */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("outbound_send_receipts_workspace_idx").on(t.workspaceId, t.createdAt),
    byApproval: index("outbound_send_receipts_approval_idx").on(t.approvalRequestId),
  }),
);
