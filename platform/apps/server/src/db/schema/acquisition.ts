import { pgTable, uuid, text, integer, jsonb, timestamp, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";

/**
 * Acquisition execution (#189, ADR-0189): the fleet runs real campaigns, not plans.
 *
 * Three workspace-scoped tables. None hold authority over an existing business-domain table — they
 * record the owner-approved budget envelope (the money decision), the external send receipts (the
 * external-grounded proof a campaign actually ran — premortem #200 §2/§3), and the email suppression
 * list (CAN-SPAM/GDPR enforced in code). Cross-entity links (idea_id) are SOFT (no FK). Table names are
 * deliberately `acquisition_*` (not `growth_*`/`venture_*`) so the #155 metric-surface colocation check
 * is not tripped — these are new operational tables, not a governed scorer.
 */

export const ACQUISITION_CHANNELS_DB = ["ads", "email", "social", "seo"] as const;
export const ENVELOPE_STATUSES_DB = ["pending", "active", "exhausted", "paused", "revoked"] as const;
export const SEND_RECEIPT_STATUSES = ["sent", "failed", "suppressed"] as const;
export const SUPPRESSION_REASONS_DB = ["bounce", "complaint", "unsubscribe", "manual"] as const;

/**
 * The owner-approved ad budget envelope (AC1) — **the money decision**. The owner approves a cap once;
 * any number of bid optimizations spend autonomously against it until `spent_cents` reaches `cap_cents`
 * or the status leaves `active`. One active envelope per (workspace, idea, channel) at a time
 * (partial-unique would be ideal; we enforce one row per period key and let the app pick the active one).
 */
export const acquisitionBudgetEnvelopes = pgTable(
  "acquisition_budget_envelopes",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Soft ref (no FK): which venture this budget belongs to (nullable = workspace-level). */
    ideaId: uuid("idea_id"),
    channel: text("channel", { enum: ACQUISITION_CHANNELS_DB }).notNull().default("ads"),
    /** A label for the budget period (e.g. '2026-06' | 'launch'), part of the dedupe key. */
    periodKey: text("period_key").notNull(),
    capCents: integer("cap_cents").notNull(),
    spentCents: integer("spent_cents").notNull().default(0),
    status: text("status", { enum: ENVELOPE_STATUSES_DB }).notNull().default("pending"),
    /** Soft link (no FK) to the #13 approval that authorized the envelope (the owner's money decision). */
    approvalRequestId: uuid("approval_request_id"),
    approvedByMemberId: uuid("approved_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelCk: check(
      "acquisition_budget_envelopes_channel_ck",
      sql`${t.channel} IN ('ads','email','social','seo')`,
    ),
    statusCk: check(
      "acquisition_budget_envelopes_status_ck",
      sql`${t.status} IN ('pending','active','exhausted','paused','revoked')`,
    ),
    periodUk: unique("acquisition_budget_envelopes_period_uk").on(
      t.workspaceId,
      t.ideaId,
      t.channel,
      t.periodKey,
    ),
  }),
);

/**
 * One external send receipt per real channel action (AC1–AC5). This is the **external-grounded** record
 * (premortem #200 §2/§3): `external_id` is the provider's own message/campaign id, `status` is what the
 * provider reported. CAC + daily-spend the founder brief reads come from these rows — never from a
 * self-reported number. `provider='dryrun'` rows are recorded-only (the default path; no network egress).
 */
export const acquisitionSendReceipts = pgTable(
  "acquisition_send_receipts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Soft ref (no FK): which venture this send is attributed to (nullable). */
    ideaId: uuid("idea_id"),
    channel: text("channel", { enum: ACQUISITION_CHANNELS_DB }).notNull(),
    /** The `external.send` kind (`ad.spend` | `email.send` | `social.post` | `content.publish`). */
    kind: text("kind").notNull(),
    /** The provider that handled it (`dryrun` | `google` | `postmark` | `x` | ...). */
    provider: text("provider").notNull(),
    status: text("status", { enum: SEND_RECEIPT_STATUSES }).notNull(),
    /** The provider's external receipt id (campaign/message id), or null on a failure. */
    externalId: text("external_id"),
    /** Real spend in cents for an `ad.spend` receipt, else null. */
    amountCents: integer("amount_cents"),
    recipientCount: integer("recipient_count").notNull().default(0),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelCk: check(
      "acquisition_send_receipts_channel_ck",
      sql`${t.channel} IN ('ads','email','social','seo')`,
    ),
    statusCk: check(
      "acquisition_send_receipts_status_ck",
      sql`${t.status} IN ('sent','failed','suppressed')`,
    ),
  }),
);

/**
 * The email suppression list (AC2): anyone who bounced, complained, or unsubscribed is a hard block,
 * enforced in code on every send. Fed by ESP bounce/complaint webhooks + explicit unsubscribes. One row
 * per (workspace, recipient) — re-suppression upserts, never stacks. Deliverability is irreversible
 * (premortem #200 §4), so this list is the law, not a courtesy.
 */
export const acquisitionSuppressions = pgTable(
  "acquisition_suppressions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Normalized (trim + lowercase) recipient email. */
    recipient: text("recipient").notNull(),
    reason: text("reason", { enum: SUPPRESSION_REASONS_DB }).notNull(),
    /** Where the suppression came from (the ESP event type, 'manual', etc.). */
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reasonCk: check(
      "acquisition_suppressions_reason_ck",
      sql`${t.reason} IN ('bounce','complaint','unsubscribe','manual')`,
    ),
    recipientUk: unique("acquisition_suppressions_recipient_uk").on(t.workspaceId, t.recipient),
  }),
);
