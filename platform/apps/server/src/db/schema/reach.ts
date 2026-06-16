import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import {
  REACH_CHANNELS,
  REACH_ENROLLMENT_STATUSES,
  REACH_RECEIPT_KINDS,
  REACH_RUN_STATUSES,
  REACH_SEND_STATUSES,
  REACH_VARIANTS,
} from "../../reach/types.js";

/**
 * Reach outbound demand-gen tables (#280, ADR-0280). Four workspace-scoped tables. Numbered 0280 BY ISSUE
 * (ADR-0099) and deliberately NOT `venture_`/`growth_`/`demand_`/`moat_`-prefixed so the #155 colocation
 * gate does not class them as governed metric surfaces.
 *
 *   - `reach_contacts`  — the dedupe ledger + cadence enrolment. ONE row per (workspace, contact_key); the
 *     unique index IS the "never re-touch last week's list" guarantee.
 *   - `reach_sends`     — one row per send ATTEMPT (any outcome) — the audit trail + measurement denominator.
 *   - `reach_receipts`  — EXTERNAL engagement only (open/reply/booked), each with a non-empty external_ref;
 *     the only source of outcome truth, idempotent on (workspace, send, kind, external_ref).
 *   - `reach_runs`      — one row per cron batch: what it found/sent + the self-tuning report it produced.
 *
 * The `contact_key` is the normalised email / LinkedIn URL / name|company — the dedupe identity, never
 * free signal text. Only `workspace_id` carries the #3 tenant boundary (ON DELETE CASCADE).
 */

export const reachContacts = pgTable(
  "reach_contacts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Stable dedupe identity (email:/linkedin:/id:…). Unique per workspace. */
    contactKey: text("contact_key").notNull(),
    /** Human label for the audit surface (no instruction text). */
    recipientLabel: text("recipient_label").notNull().default(""),
    /** The channel the prospect was first enrolled on. */
    channel: text("channel", { enum: REACH_CHANNELS }).notNull(),
    /** Cadence enrolment lifecycle. */
    status: text("status", { enum: REACH_ENROLLMENT_STATUSES }).notNull().default("active"),
    /** The next cadence step to take (0 = freshly enrolled). */
    currentStep: integer("current_step").notNull().default(0),
    lastStepAt: timestamp("last_step_at", { withTimezone: true }),
    /** The ICP fit/signal score at enrolment (0–100). */
    score: integer("score").notNull().default(0),
    /** The signal kind the first opener was built around, or null. */
    signalKind: text("signal_kind"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueContact: uniqueIndex("reach_contacts_unique").on(t.workspaceId, t.contactKey),
    byWorkspaceStatus: index("reach_contacts_workspace_status_idx").on(t.workspaceId, t.status),
    channelCk: check("reach_contacts_channel_ck", sql`${t.channel} IN ('email','linkedin')`),
    statusCk: check(
      "reach_contacts_status_ck",
      sql`${t.status} IN ('active','completed','replied','opted_out')`,
    ),
  }),
);

export const reachSends = pgTable(
  "reach_sends",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contactKey: text("contact_key").notNull(),
    channel: text("channel", { enum: REACH_CHANNELS }).notNull(),
    status: text("status", { enum: REACH_SEND_STATUSES }).notNull(),
    variant: text("variant", { enum: REACH_VARIANTS }).notNull(),
    signalKind: text("signal_kind"),
    subject: text("subject").notNull().default(""),
    /** Provider message id when sent, else null. */
    externalId: text("external_id"),
    /** UTC hour (0–23) the send fired, or null. */
    sentHourUtc: integer("sent_hour_utc"),
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceCreated: index("reach_sends_workspace_created_idx").on(t.workspaceId, t.createdAt),
    byContact: index("reach_sends_contact_idx").on(t.workspaceId, t.contactKey),
    channelCk: check("reach_sends_channel_ck", sql`${t.channel} IN ('email','linkedin')`),
    variantCk: check(
      "reach_sends_variant_ck",
      sql`${t.variant} IN ('pain','outcome','social_proof')`,
    ),
    statusCk: check(
      "reach_sends_status_ck",
      sql`${t.status} IN ('sent','queued','suppressed','rate_limited','skipped','failed')`,
    ),
  }),
);

export const reachReceipts = pgTable(
  "reach_receipts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sendId: uuid("send_id")
      .notNull()
      .references(() => reachSends.id, { onDelete: "cascade" }),
    contactKey: text("contact_key").notNull(),
    kind: text("kind", { enum: REACH_RECEIPT_KINDS }).notNull(),
    /** The proof it is external (provider/event id) — non-empty. */
    externalRef: text("external_ref").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("reach_receipts_workspace_idx").on(t.workspaceId, t.createdAt),
    bySend: index("reach_receipts_send_idx").on(t.sendId),
    uniqueReceipt: uniqueIndex("reach_receipts_unique").on(
      t.workspaceId,
      t.sendId,
      t.kind,
      t.externalRef,
    ),
    kindCk: check("reach_receipts_kind_ck", sql`${t.kind} IN ('open','reply','booked')`),
  }),
);

export const reachRuns = pgTable(
  "reach_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The prospect source used (mock/clay/lusha/vibe). */
    sourceKind: text("source_kind").notNull(),
    status: text("status", { enum: REACH_RUN_STATUSES }).notNull(),
    prospectsFound: integer("prospects_found").notNull().default(0),
    messagesSent: integer("messages_sent").notNull().default(0),
    messagesQueued: integer("messages_queued").notNull().default(0),
    suppressedCount: integer("suppressed_count").notNull().default(0),
    rateLimitedCount: integer("rate_limited_count").notNull().default(0),
    /** The self-tuning report this run produced (current → next config + changes). */
    tuningReport: jsonb("tuning_report").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceCreated: index("reach_runs_workspace_created_idx").on(t.workspaceId, t.createdAt),
    statusCk: check(
      "reach_runs_status_ck",
      sql`${t.status} IN ('completed','awaiting_data_funding','skipped')`,
    ),
  }),
);
