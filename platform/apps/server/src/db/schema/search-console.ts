import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Search Console auto-submit receipts (#265, ADR-0265). One workspace-scoped table:
 * `search_console_submissions` — one row per sitemap-submission attempt and its EXTERNALLY-VERIFIED outcome.
 *
 * Every row records what Scout tried (site + sitemap URL, indexing-request count) and what Google Search
 * Console actually confirmed (`accepted`, `indexed_pages`) — premortem #200 §2: a success only counts when
 * the provider confirms it. A `pending_approval` / `rejected` / `not_connected` row never claims a submit;
 * an `accepted=false` row is honestly "submitted but unverified". With the default dry-run provider the loop
 * records only the pre-approval states, so the founder console's SEO tile stays honest.
 *
 * The table name is deliberately `search_console_*` (not venture_/growth_/demand_/moat_-prefixed) so the
 * #155 colocation gate does not class it as a governed metric surface. No FK beyond the tenant boundary.
 */
export const searchConsoleSubmissions = pgTable(
  "search_console_submissions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The site origin the submission was scoped to (e.g. 'https://ipop.ai'). Structural data. */
    siteUrl: text("site_url").notNull(),
    /** The sitemap URL submitted — always same-origin as site_url (decideSitemapSubmission enforces it). */
    sitemapUrl: text("sitemap_url").notNull(),
    /** pending_approval | submitted | verified | failed | rejected | not_connected. */
    status: text("status").notNull(),
    /** The #13 approval this submission parked / ran under (null for rejected / not_connected). */
    approvalRequestId: uuid("approval_request_id"),
    /** The provider that performed (or would perform) the submit. `dryrun` rows touch nothing live. */
    provider: text("provider").notNull(),
    /** True iff Search Console CONFIRMED the sitemap present with zero errors (external proof). */
    accepted: boolean("accepted").notNull().default(false),
    /** Indexed-page count Search Console reported, or NULL when unknown (never a fabricated number). */
    indexedPages: integer("indexed_pages"),
    /** How many indexing requests were sent for new/changed URLs in this submission. */
    indexingRequested: integer("indexing_requested").notNull().default(0),
    /** Free-text reason / provider detail (sanitised, bounded). */
    detail: text("detail").notNull().default(""),
    extra: jsonb("extra").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceCreatedIdx: index("search_console_submissions_workspace_created_idx").on(
      t.workspaceId,
      t.createdAt,
    ),
  }),
);
