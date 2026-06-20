import { pgTable, uuid, text, integer, timestamp, jsonb, index, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { agentSessions } from "./agent-sessions.js";
import { deployments } from "./deployments.js";
import { members } from "./identities.js";

/**
 * Stripe revenue rails (issue #98, ADR-0043). Three workspace-scoped tables, all additive + independent
 * of the #96 venture tables (the scorecard reads `revenue_evidence`; neither branch depends on the
 * other's schema). Secrets never land here; the webhook `raw` payload is REDACTED before persistence.
 */

/**
 * A hosted payment link minted for a session's deployed app (INBOUND money). Immutable — one row per
 * created link. `deployment_id` is the "attach the link to the deployment record" association (#98 §3).
 * Workspace/channel-scoped for tenant isolation (#9). Amounts only — no card data, no secret.
 */
export const paymentLinks = pgTable(
  "payment_links",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    // The deployment this link collects payment for (SET NULL on delete via the migration).
    deploymentId: uuid("deployment_id").references(() => deployments.id, { onDelete: "set null" }),
    provider: text("provider").notNull(), // none | stripe
    productId: text("product_id").notNull(),
    priceId: text("price_id").notNull(),
    providerLinkId: text("provider_link_id").notNull(),
    url: text("url").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    interval: text("interval"), // day|week|month|year | null (one-time)
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySession: index("payment_links_session_idx").on(t.sessionId),
    byWorkspace: index("payment_links_workspace_idx").on(t.workspaceId),
  }),
);

/**
 * A real payment event received from the provider's signature-verified webhook (#98 §4). Deduped per
 * workspace by the provider's event id (the unique constraint), so a replayed delivery is a no-op.
 * `raw` is the REDACTED webhook body (any leaked secret value scrubbed). `channel_id`/`session_id`/
 * `deployment_id` are recovered from the payment link's metadata when present (nullable — a webhook can
 * arrive without them).
 */
export const revenueEvents = pgTable(
  "revenue_events",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "set null" }),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    deploymentId: uuid("deployment_id").references(() => deployments.id, { onDelete: "set null" }),
    provider: text("provider").notNull(), // none | stripe
    providerEventId: text("provider_event_id").notNull(),
    type: text("type").notNull(), // e.g. checkout.session.completed
    amountCents: integer("amount_cents").notNull().default(0),
    currency: text("currency").notNull(),
    status: text("status").notNull(), // e.g. paid | succeeded | complete
    // The #386 tracking ref carried through Stripe checkout metadata (slice 3, #402). NULL ⇒ the payment
    // carried no ref (or pre-dates this column) ⇒ stays `unattributed` in the attribution projection.
    trackingRef: text("tracking_ref"),
    raw: jsonb("raw").notNull().default(sql`'{}'::jsonb`), // REDACTED payload
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("revenue_events_workspace_idx").on(t.workspaceId),
    bySession: index("revenue_events_session_idx").on(t.sessionId),
    // Webhook idempotency: at most one row per (workspace, provider event id).
    dedupe: unique("revenue_events_workspace_event_uq").on(t.workspaceId, t.providerEventId),
  }),
);

/**
 * Willingness-to-pay evidence derived from a real payment (#98 §5). The ADDITIVE seam the #96 venture
 * scorecard consumes — a real charge is the strongest fundability signal. Independent of any #96 table.
 */
export const revenueEvidence = pgTable(
  "revenue_evidence",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // willingness_to_pay
    source: text("source").notNull(), // revenue
    revenueEventId: uuid("revenue_event_id").references(() => revenueEvents.id, {
      onDelete: "cascade",
    }),
    amountCents: integer("amount_cents").notNull().default(0),
    currency: text("currency").notNull(),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("revenue_evidence_workspace_idx").on(t.workspaceId),
    bySession: index("revenue_evidence_session_idx").on(t.sessionId),
  }),
);
