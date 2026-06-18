import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * #269 Echo social posting via the connect-once aggregator bridge — two workspace-scoped tables backing the
 * multi-network fan-out.
 *
 *   - `social_posts`        — one record per Echo post. A post is stored as `draft`, parked behind the #13
 *                             owner gate as `pending_approval` (the HARD constraint: a post — irreversible —
 *                             never fans out without an explicit owner approval), then `published` /
 *                             `partially_published` / `scheduled` / `failed`. `approval_request_id` is the
 *                             load-bearing column — a post only fans out through an approval row (a soft ref
 *                             so the receipt outlives a pruned approval). `aggregator_ref` is the bridge's
 *                             overall post id, the handle the read-back verification reads against.
 *   - `social_post_results` — the per-network EXTERNAL receipts (premortem #200 §2/§3): a network counts as
 *                             `published` ONLY from a recorded row carrying a real `external_id`, and the
 *                             `permalink` is read back from the aggregator's API. Published-post metrics are
 *                             computed ONLY from these rows, never self-reported.
 *
 * Tenant boundary: `workspace_id` (#3, ON DELETE CASCADE). The names are deliberately NOT
 * `venture_`/`growth_`/`moat_`-prefixed so the #155 colocation gate does not class them as governed
 * metric surfaces.
 */

export const SOCIAL_POST_STATUSES = [
  "draft",
  "pending_approval",
  "scheduled",
  "published",
  "partially_published",
  "failed",
] as const;

export const SOCIAL_RESULT_STATUSES = ["published", "scheduled", "failed"] as const;

export const socialPosts = pgTable(
  "social_posts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    // The target networks as a comma-joined list (the validated allow-list; structural, never parsed content).
    networks: text("networks").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    status: text("status", { enum: SOCIAL_POST_STATUSES }).notNull().default("draft"),
    approvalRequestId: uuid("approval_request_id"),
    aggregatorRef: text("aggregator_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("social_posts_workspace_idx").on(t.workspaceId, t.createdAt),
    statusCk: check(
      "social_posts_status_ck",
      sql`${t.status} IN ('draft','pending_approval','scheduled','published','partially_published','failed')`,
    ),
  }),
);

export const socialPostResults = pgTable(
  "social_post_results",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => socialPosts.id, { onDelete: "cascade" }),
    network: text("network").notNull(),
    status: text("status", { enum: SOCIAL_RESULT_STATUSES }).notNull(),
    externalId: text("external_id"),
    permalink: text("permalink"),
    error: text("error"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPost: index("social_post_results_post_idx").on(t.postId),
    byWorkspace: index("social_post_results_workspace_idx").on(t.workspaceId),
    statusCk: check(
      "social_post_results_status_ck",
      sql`${t.status} IN ('published','scheduled','failed')`,
    ),
  }),
);
