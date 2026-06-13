import { pgTable, uuid, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import { ventureIdeas } from "./venture.js";
import { supportTickets } from "./voice.js";

/**
 * Support Desk persistence (#190, ADR-0190). Two workspace-scoped tables layered on the #114
 * `support_tickets` inbox: the venture knowledge base (the source of every answer's receipts) and the
 * external-receipt log (the only trustworthy resolution signal, premortem §2). All `workspace_id`-scoped
 * with `onDelete: cascade` (the #3 tenant boundary); `venture_idea_id` / `source_ticket_id` / `ticket_id`
 * / `created_by_member_id` are soft links (SET NULL) so a KB entry / receipt outlives a pruned
 * idea/ticket/member. Additive + independent of every other branch's schema.
 */

export const KB_SOURCES = ["manual", "resolved_ticket"] as const;
/**
 * Receipt kinds. `delivered`/`opened`/`bounced`/`resolved` are EXTERNAL provider events (the source of
 * truth for resolution metrics, premortem §2). `auto_sent` is an INTERNAL audit marker the platform writes
 * when it autonomously sends a reply — it is the per-day auto-send cap counter and the trail, and is
 * deliberately NOT counted as a resolution (only `resolved` is).
 */
export const RECEIPT_KINDS = ["delivered", "opened", "bounced", "resolved", "auto_sent"] as const;

/** The venture knowledge base. One row per curated/distilled answer; deduped per workspace by slug. */
export const supportKbEntries = pgTable(
  "support_kb_entries",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureIdeaId: uuid("venture_idea_id").references(() => ventureIdeas.id, { onDelete: "set null" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    category: text("category").notNull(),
    source: text("source", { enum: KB_SOURCES }).notNull().default("manual"),
    sourceTicketId: uuid("source_ticket_id").references(() => supportTickets.id, { onDelete: "set null" }),
    provenance: text("provenance").notNull(),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("support_kb_entries_workspace_idx").on(t.workspaceId),
    byCategory: index("support_kb_entries_workspace_category_idx").on(t.workspaceId, t.category),
    byIdea: index("support_kb_entries_idea_idx").on(t.ventureIdeaId),
    dedupe: unique("support_kb_entries_slug_uq").on(t.workspaceId, t.slug),
  }),
);

/**
 * The external-receipt log. One row per provider delivery/resolution event. A `resolved` receipt is the
 * only thing that counts a ticket "resolved (verified)"; deduped per workspace by (ticket, kind, ref) so a
 * replayed webhook is idempotent (a NULL ticket_id is never deduped — Postgres NULLs are distinct).
 */
export const supportReceipts = pgTable(
  "support_receipts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").references(() => supportTickets.id, { onDelete: "set null" }),
    kind: text("kind", { enum: RECEIPT_KINDS }).notNull(),
    providerRef: text("provider_ref").notNull(),
    detail: text("detail"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("support_receipts_workspace_idx").on(t.workspaceId),
    byTicket: index("support_receipts_ticket_idx").on(t.ticketId),
    dedupe: unique("support_receipts_ref_uq").on(t.workspaceId, t.ticketId, t.kind, t.providerRef),
  }),
);
