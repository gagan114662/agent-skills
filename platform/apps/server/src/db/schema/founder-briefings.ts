import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Founder Briefings delivery audit (#173, ADR-0173). ONE workspace-scoped table — the delivery log +
 * idempotency watermark for the daily brief / weekly founder report. This is the ONLY thing the
 * reporting layer writes: bookkeeping about its own sends (exactly as #148 `PagerService` audits to
 * `reliability_pages`), NOT authority over any business-domain table.
 *
 * `unique(workspace_id, kind, period_key)` IS the watermark: a second tick in the same period inserts
 * nothing (`onConflictDoNothing`), so a 1-hour interval still sends exactly one daily brief per day.
 * `channels` is the per-channel result audit (email/slack); `period_key` is `YYYY-MM-DD` (daily) or
 * ISO `YYYY-Www` (weekly). Only `workspace_id` carries the #3 tenant boundary (`onDelete: cascade`).
 */

export const BRIEFING_KINDS = ["daily", "weekly"] as const;

export const founderBriefings = pgTable(
  "founder_briefings",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** `daily` | `weekly`. */
    kind: text("kind", { enum: BRIEFING_KINDS }).notNull(),
    /** `YYYY-MM-DD` (daily) | ISO `YYYY-Www` (weekly) — the per-period dedup anchor. */
    periodKey: text("period_key").notNull(),
    /** Whether at least one channel delivered (false ⇒ no owner / transport error — still audited). */
    delivered: boolean("delivered").notNull(),
    /** Per-channel delivery results (`[{channel,delivered,reason}]`) — the audit trail. */
    channels: jsonb("channels").notNull().default(sql`'[]'::jsonb`),
    /** Word count of the rendered digest (the daily brief's "< 200 words" is provable from the row). */
    wordCount: integer("word_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePeriod: unique("founder_briefings_period_uk").on(t.workspaceId, t.kind, t.periodKey),
    kindCk: check("founder_briefings_kind_ck", sql`${t.kind} IN ('daily','weekly')`),
  }),
);
