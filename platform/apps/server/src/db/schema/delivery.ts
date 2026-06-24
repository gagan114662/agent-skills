import { pgTable, uuid, text, boolean, timestamp, jsonb, index, check, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Deliverable delivery receipts (#295, ADR-0295). One workspace-scoped table, `delivery_receipts`: the
 * durable, production-grounded proof that an APPROVED `agent.deliverable` actually SHIPPED — a live
 * published URL, a social post id, or an email message id (premortem #200 §2: "it shipped" claims must
 * rest on an external receipt, never self-report).
 *
 * The load-bearing column is `approval_request_id`: every receipt is tied to the #13 approval that
 * authorized the ship — the structural proof that nothing ships without an explicit owner approval.
 * `live` distinguishes a genuine external surface (a reachable URL / a real provider id) from a dry-run
 * record, so the console never overclaims a send that did not really leave the building.
 *
 * Only `workspace_id` carries the #3 tenant boundary (ON DELETE CASCADE). `approval_request_id` /
 * `session_id` are SOFT refs (no FK) — the receipt must outlive a pruned approval/session. The table name
 * is deliberately NOT `venture_`/`growth_`-prefixed so the #155 colocation gate does not class it as a
 * governed metric surface.
 */

export const DELIVERY_CHANNELS = ["publish", "site_pr", "social", "email"] as const;
export const DELIVERY_REVERSIBILITIES = ["reversible", "irreversible"] as const;
export const DELIVERY_STATUSES = ["shipped", "failed"] as const;
export const DELIVERABLE_FEEDBACK_CATEGORIES = [
  "helpful",
  "off_brand",
  "inaccurate",
  "unclear",
  "other",
] as const;

export const deliveryReceipts = pgTable(
  "delivery_receipts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    approvalRequestId: uuid("approval_request_id").notNull(),
    sessionId: uuid("session_id"),
    channel: text("channel", { enum: DELIVERY_CHANNELS }).notNull(),
    reversibility: text("reversibility", { enum: DELIVERY_REVERSIBILITIES }).notNull(),
    provider: text("provider").notNull(),
    live: boolean("live").notNull().default(false),
    /** The production-grounded external reference: a live URL, a post id, or a message id. */
    externalRef: text("external_ref"),
    status: text("status", { enum: DELIVERY_STATUSES }).notNull(),
    detail: jsonb("detail").notNull().default({}),
    shippedAt: timestamp("shipped_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceShipped: index("delivery_receipts_workspace_shipped_idx").on(t.workspaceId, t.shippedAt),
    byApproval: index("delivery_receipts_approval_idx").on(t.approvalRequestId),
    channelCk: check(
      "delivery_receipts_channel_ck",
      sql`${t.channel} IN ('publish','site_pr','social','email')`,
    ),
    reversibilityCk: check(
      "delivery_receipts_reversibility_ck",
      sql`${t.reversibility} IN ('reversible','irreversible')`,
    ),
    statusCk: check("delivery_receipts_status_ck", sql`${t.status} IN ('shipped','failed')`),
  }),
);

export const deliverableFeedback = pgTable(
  "deliverable_feedback",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    deliveryReceiptId: uuid("delivery_receipt_id")
      .notNull()
      .references(() => deliveryReceipts.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    category: text("category", { enum: DELIVERABLE_FEEDBACK_CATEGORIES }).notNull().default("other"),
    comment: text("comment"),
    alertNotifiedAt: timestamp("alert_notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceCreated: index("deliverable_feedback_workspace_created_idx").on(t.workspaceId, t.createdAt),
    byReceipt: index("deliverable_feedback_receipt_idx").on(t.deliveryReceiptId),
    lowRating: index("deliverable_feedback_low_rating_idx").on(t.workspaceId, t.rating, t.createdAt),
    ratingCk: check("deliverable_feedback_rating_ck", sql`${t.rating} BETWEEN 1 AND 5`),
    categoryCk: check(
      "deliverable_feedback_category_ck",
      sql`${t.category} IN ('helpful','off_brand','inaccurate','unclear','other')`,
    ),
  }),
);
