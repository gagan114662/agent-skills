import { pgTable, uuid, text, integer, timestamp, index, unique } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import { ventureIdeas } from "./venture.js";

/**
 * Customer Voice Loop persistence (#114, ADR-0114). Two workspace-scoped tables — the inbound support
 * inbox and the structured `user_voice` evidence log. All `workspace_id`-scoped with `onDelete: cascade`
 * (the #3 tenant boundary); `venture_idea_id` / `ticket_id` / `created_by_member_id` are soft links
 * (SET NULL) so an insight outlives a pruned idea/ticket/member. Additive + independent of every other
 * branch's schema.
 */

export const TICKET_CHANNELS = ["email", "webhook", "widget"] as const;
export const TICKET_STATUSES = [
  "open",
  "triaged",
  "awaiting_approval",
  "replied",
  "closed",
] as const;
export const VOICE_SENTIMENTS = ["positive", "neutral", "negative"] as const;
export const VOICE_CHURN_RISKS = ["low", "medium", "high"] as const;
export const VOICE_SOURCE_KINDS = [
  "support_ticket",
  "checkout_abandon",
  "cancellation",
  "nps",
  "brand_mention",
] as const;

/** The inbound support inbox. One row per inbound message; deduped on (workspace, channel, source_ref). */
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureIdeaId: uuid("venture_idea_id").references(() => ventureIdeas.id, {
      onDelete: "set null",
    }),
    channel: text("channel").notNull(),
    sourceRef: text("source_ref").notNull(),
    contact: text("contact"),
    subject: text("subject"),
    body: text("body").notNull(),
    sentiment: text("sentiment", { enum: VOICE_SENTIMENTS }),
    churnRisk: text("churn_risk", { enum: VOICE_CHURN_RISKS }),
    category: text("category"),
    status: text("status", { enum: TICKET_STATUSES }).notNull().default("open"),
    draftReply: text("draft_reply"),
    replyApprovalRequestId: uuid("reply_approval_request_id"),
    triageSessionId: uuid("triage_session_id"),
    csatScore: integer("csat_score"),
    csatComment: text("csat_comment"),
    csatSubmittedAt: timestamp("csat_submitted_at", { withTimezone: true }),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("support_tickets_workspace_idx").on(t.workspaceId),
    byIdea: index("support_tickets_idea_idx").on(t.ventureIdeaId),
    byStatus: index("support_tickets_workspace_status_idx").on(t.workspaceId, t.status),
    dedupe: unique("support_tickets_channel_ref_uq").on(t.workspaceId, t.channel, t.sourceRef),
  }),
);

/**
 * The structured `user_voice` evidence log — one row per classified signal (support ticket, checkout
 * abandon, cancellation reason, NPS response). `kind` is always `user_voice` (extends the #98
 * `revenue_evidence` kind-tagged pattern); `source_kind` is the discriminator. Deduped on
 * (workspace, source_kind, source_ref); a null `source_ref` is never deduped (Postgres NULLs are distinct).
 */
export const voiceInsights = pgTable(
  "voice_insights",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureIdeaId: uuid("venture_idea_id").references(() => ventureIdeas.id, {
      onDelete: "set null",
    }),
    ticketId: uuid("ticket_id").references(() => supportTickets.id, { onDelete: "set null" }),
    kind: text("kind").notNull().default("user_voice"),
    sourceKind: text("source_kind", { enum: VOICE_SOURCE_KINDS }).notNull(),
    sentiment: text("sentiment", { enum: VOICE_SENTIMENTS }).notNull(),
    churnRisk: text("churn_risk", { enum: VOICE_CHURN_RISKS }).notNull(),
    category: text("category").notNull(),
    npsScore: integer("nps_score"),
    summary: text("summary").notNull(),
    sourceRef: text("source_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("voice_insights_workspace_idx").on(t.workspaceId),
    byIdea: index("voice_insights_idea_idx").on(t.ventureIdeaId),
    dedupe: unique("voice_insights_source_ref_uq").on(t.workspaceId, t.sourceKind, t.sourceRef),
  }),
);
