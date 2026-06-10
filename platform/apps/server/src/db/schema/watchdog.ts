import { pgTable, uuid, text, integer, timestamp, index, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Fleet-watchdog persistence (#105, ADR-0105). One workspace-scoped table — the durable revival
 * lineage. It makes the bounded restart policy survive a process restart: the revival count, its
 * rolling window, the backoff input, the lineage pointer (`current_session_id`), and the last failure
 * class all persist, so a flapping session can never reset its budget by crashing. When the per-window
 * limit is hit (or a non-retryable class is seen) the watchdog escalates instead of reviving.
 *
 * The session-id columns are **soft references** (no FK): a session row is audit history that may be
 * pruned independently, and the lineage must outlive it. Only `workspace_id` carries the #3 tenant
 * boundary (`onDelete: cascade`).
 */

export const WATCHDOG_REVIVAL_STATUSES = ["active", "escalated", "recovered"] as const;

export const watchdogRevivals = pgTable(
  "watchdog_revivals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The first session in the lineage (the originally-detected stall). */
    rootSessionId: uuid("root_session_id").notNull(),
    /** The latest live replacement session this lineage points at (= root until first revival). */
    currentSessionId: uuid("current_session_id").notNull(),
    /** Revivals attempted within the current rolling window. */
    revivals: integer("revivals").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
    lastRevivalAt: timestamp("last_revival_at", { withTimezone: true }),
    /** The persisted failure taxonomy class (the watchdog "learns which errors are retryable"). */
    lastErrorClass: text("last_error_class"),
    status: text("status", { enum: WATCHDOG_REVIVAL_STATUSES }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceStatus: index("watchdog_revivals_workspace_status_idx").on(t.workspaceId, t.status),
    byCurrentSession: index("watchdog_revivals_current_session_idx").on(
      t.workspaceId,
      t.currentSessionId,
    ),
    uniqueRoot: unique("watchdog_revivals_root_uk").on(t.workspaceId, t.rootSessionId),
    statusCk: check(
      "watchdog_revivals_status_ck",
      sql`${t.status} IN ('active','escalated','recovered')`,
    ),
  }),
);
