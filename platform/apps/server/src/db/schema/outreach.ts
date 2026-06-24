import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  check,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Outreach engine tables (#225, ADR-0225). Two workspace-scoped tables:
 *
 *   - `outreach_messages` — one row per composed, owner-gated message attempt (the audit trail + the
 *     experiment denominator). A message is inert until the owner approves the matching #13 request.
 *   - `outreach_receipts` — EXTERNAL receipts only (a reply / booked meeting / signup), each carrying a
 *     non-empty `external_ref` (the proof). This is the ONLY source of experiment + pipeline truth
 *     (premortem #200 §2: metrics are external receipts only).
 *
 * Only `workspace_id` carries the #3 tenant boundary (ON DELETE CASCADE). `idea_id`/`account_id`/
 * `buyer_brief_id` are SOFT refs (no FK) — the receipt/message must outlive a pruned venture/brief.
 * No raw PII: the recipient is an OPAQUE `recipient_ref` (`<channel>:<contactId>`); the human label is
 * derived from structured identity only. Names are deliberately NOT `venture_`/`growth_`-prefixed so the
 * #155 colocation gate does not class them as governed metric surfaces.
 */

export const OUTREACH_CHANNELS = ["email", "linkedin", "x"] as const;
export const OUTREACH_VARIANTS = ["time_saved", "productivity", "cost"] as const;
export const OUTREACH_MESSAGE_STATUSES = [
  "drafted",
  "blocked",
  "pending_approval",
  "sent",
  "failed",
] as const;
export const OUTREACH_RECEIPT_KINDS = ["reply", "meeting", "signup"] as const;
export const OUTREACH_SPAM_RISK_LEVELS = ["clean", "review", "block"] as const;

export const outreachMessages = pgTable(
  "outreach_messages",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ideaId: uuid("idea_id"),
    prospectKey: text("prospect_key").notNull(),
    accountId: text("account_id"),
    buyerBriefId: uuid("buyer_brief_id"),
    channel: text("channel", { enum: OUTREACH_CHANNELS }).notNull(),
    variant: text("variant", { enum: OUTREACH_VARIANTS }).notNull(),
    signalKind: text("signal_kind"),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull(),
    recipientLabel: text("recipient_label").notNull().default(""),
    recipientRef: text("recipient_ref").notNull(),
    spamRiskScore: integer("spam_risk_score").notNull().default(0),
    spamRiskLevel: text("spam_risk_level", { enum: OUTREACH_SPAM_RISK_LEVELS })
      .notNull()
      .default("clean"),
    spamRiskReasons: jsonb("spam_risk_reasons").$type<string[]>().notNull().default([]),
    experimentKey: text("experiment_key").notNull(),
    status: text("status", { enum: OUTREACH_MESSAGE_STATUSES }).notNull(),
    approvalRequestId: uuid("approval_request_id"),
    provider: text("provider").notNull().default("dryrun"),
    /** Provider message id when the approved send leaves the building, else null. */
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceCreated: index("outreach_messages_workspace_created_idx").on(
      t.workspaceId,
      t.createdAt,
    ),
    byExperiment: index("outreach_messages_experiment_idx").on(t.workspaceId, t.experimentKey),
    channelCk: check("outreach_messages_channel_ck", sql`${t.channel} IN ('email','linkedin','x')`),
    variantCk: check(
      "outreach_messages_variant_ck",
      sql`${t.variant} IN ('time_saved','productivity','cost')`,
    ),
    statusCk: check(
      "outreach_messages_status_ck",
      sql`${t.status} IN ('drafted','blocked','pending_approval','sent','failed')`,
    ),
    spamRiskScoreCk: check(
      "outreach_messages_spam_risk_score_ck",
      sql`${t.spamRiskScore} BETWEEN 0 AND 100`,
    ),
    spamRiskLevelCk: check(
      "outreach_messages_spam_risk_level_ck",
      sql`${t.spamRiskLevel} IN ('clean','review','block')`,
    ),
  }),
);

export const outreachReceipts = pgTable(
  "outreach_receipts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => outreachMessages.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: OUTREACH_RECEIPT_KINDS }).notNull(),
    externalRef: text("external_ref").notNull(),
    replyBody: text("reply_body"),
    replyFrom: text("reply_from"),
    replySubject: text("reply_subject"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("outreach_receipts_workspace_idx").on(t.workspaceId, t.createdAt),
    byMessage: index("outreach_receipts_message_idx").on(t.messageId),
    // Idempotency: the same external receipt (a webhook re-delivery) lands once.
    uniqueReceipt: uniqueIndex("outreach_receipts_unique").on(
      t.workspaceId,
      t.messageId,
      t.kind,
      t.externalRef,
    ),
    kindCk: check("outreach_receipts_kind_ck", sql`${t.kind} IN ('reply','meeting','signup')`),
  }),
);
