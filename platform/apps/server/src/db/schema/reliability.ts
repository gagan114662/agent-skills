import { pgTable, uuid, text, integer, boolean, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Reliability surface persistence (#148, ADR-0148). Two workspace-scoped tables that overlay the #112
 * SRE incident with the incident.io-class surface — WITHOUT touching `sre_incidents` (additive).
 *
 *  - `reliability_incidents` — one row per SRE incident: the `#incident-NNN` war-room channel, the
 *    per-workspace `seq` that names it, the stored AI investigation note, and the paging state
 *    (`last_paged_at` / `acked_at` / `page_count`) the escalation re-page reads. `incident_id` is a
 *    **soft ref** (no FK) so the overlay outlives pruned incident history; a unique index keeps it
 *    one-per-incident. Only `workspace_id` carries the #3 tenant boundary (cascade).
 *  - `reliability_pages` — the page audit + rate-limit window source. Every paging attempt (delivered
 *    or suppressed) is a row; the rate limiter counts recent rows per workspace. uptime pages carry no
 *    incident (`incident_id` null).
 */

export const RELIABILITY_PAGE_SOURCES = ["sre", "uptime"] as const;
export const RELIABILITY_PAGE_KINDS = [
  "opened",
  "repaged",
  "resolved",
  "uptime_down",
  "uptime_recover",
] as const;

export const reliabilityIncidents = pgTable(
  "reliability_incidents",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Soft ref to `sre_incidents.id` (no FK — the overlay outlives pruned incident history). */
    incidentId: uuid("incident_id").notNull(),
    /** The per-workspace incident sequence that names the war-room channel (`#incident-NNN`). */
    seq: integer("seq").notNull(),
    /** The `#incident-NNN` channel (soft ref to `channels.id`, null until created). */
    channelId: uuid("channel_id"),
    /** The stored AI investigation note (markdown), null until the investigation runs. */
    investigationNote: text("investigation_note"),
    /** When the owner was last paged for this incident — the escalation cooldown reference. */
    lastPagedAt: timestamp("last_paged_at", { withTimezone: true }),
    /** When the owner acknowledged — non-null stops the escalation re-page. */
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    /** Pages delivered for this incident (audit). */
    pageCount: integer("page_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("reliability_incidents_workspace_idx").on(t.workspaceId),
  }),
);

export const reliabilityPages = pgTable(
  "reliability_pages",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    source: text("source", { enum: RELIABILITY_PAGE_SOURCES }).notNull(),
    /** Soft ref to the incident this page belongs to (null for uptime pages). */
    incidentId: uuid("incident_id"),
    kind: text("kind", { enum: RELIABILITY_PAGE_KINDS }).notNull(),
    /** The owner's verified contact the page was sent to (email). */
    recipient: text("recipient").notNull(),
    delivered: boolean("delivered").notNull().default(false),
    /** Why the page was suppressed (from `decidePage`), null when delivered. */
    suppressedReason: text("suppressed_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceCreated: index("reliability_pages_workspace_created_idx").on(t.workspaceId, t.createdAt),
    sourceCk: check("reliability_pages_source_ck", sql`${t.source} IN ('sre','uptime')`),
    kindCk: check(
      "reliability_pages_kind_ck",
      sql`${t.kind} IN ('opened','repaged','resolved','uptime_down','uptime_recover')`,
    ),
  }),
);
