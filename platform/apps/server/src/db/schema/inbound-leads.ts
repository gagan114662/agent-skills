import { boolean, pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Inbound lead capture (GAP 1 of the leads centre, ADR-0400) — the autonomous loop's INBOUND mouth. The
 * public landing "what are you hoping the fleet can do?" form posts here so a real prospect persists and
 * feeds the #222 discovery engine, instead of being dropped client-side.
 *
 * Additive + workspace-scoped (#3, ON DELETE CASCADE): a lead always belongs to the workspace that owns the
 * site it arrived on (the marketing-owner workspace for the public landing). Holds NO secret, NO money — a
 * name, an email, an intent message, the source surface, and an optional tracking_ref reserved for #386
 * attribution. Every free-text field is UNTRUSTED inbound DATA, sanitized at the write site (#200 §6).
 *
 * The name is deliberately NOT tenant_usage / venture_ / growth_ / demand_ / moat_ -prefixed so the #155
 * colocation gate does not class it as a governed metric surface — it is a CRM intake row, not a metric.
 * Numbered 0400 by a free prefix (per ADR-0099) to dodge sibling-workspace collisions in the shared
 * migration sequence.
 */
export const INBOUND_LEAD_STATUSES = ["new", "working", "converted", "archived"] as const;
export type InboundLeadStatus = (typeof INBOUND_LEAD_STATUSES)[number];

export const inboundLeads = pgTable(
  "inbound_leads",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Free-text intake fields — UNTRUSTED, sanitized + length-capped at the write site (leads/inbound.ts).
    name: text("name"),
    email: text("email").notNull(),
    message: text("message").notNull(),
    // The surface the lead arrived on (e.g. 'landing_form') — a structural label, not free text.
    source: text("source").notNull().default("landing_form"),
    // Reserved for #386 attribution: the recovered tracking ref so a future payment credits this lead.
    trackingRef: text("tracking_ref"),
    emailHash: text("email_hash"),
    submitterHash: text("submitter_hash"),
    verified: boolean("verified").notNull().default(false),
    verificationTokenHash: text("verification_token_hash"),
    verificationSentAt: timestamp("verification_sent_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    status: text("status", { enum: INBOUND_LEAD_STATUSES }).notNull().default("new"),
    assigneeMemberId: uuid("assignee_member_id"),
    nextAction: text("next_action"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
    slaNotifiedAt: timestamp("sla_notified_at", { withTimezone: true }),
    reachContactKey: text("reach_contact_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("inbound_leads_workspace_idx").on(t.workspaceId, t.createdAt),
    byWorkspaceStatus: index("inbound_leads_workspace_status_idx").on(t.workspaceId, t.status, t.createdAt),
    byWorkspaceEmailHash: index("inbound_leads_workspace_email_hash_idx").on(t.workspaceId, t.emailHash, t.createdAt),
    byVerifyToken: index("inbound_leads_verify_token_idx").on(t.verificationTokenHash),
  }),
);
