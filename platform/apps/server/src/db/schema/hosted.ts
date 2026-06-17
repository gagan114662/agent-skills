import { pgTable, uuid, text, boolean, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * #266 ipop hosted publishing — three workspace-scoped tables backing multi-tenant customer blogs +
 * landing pages with ZERO repo and ZERO deploy the customer can see.
 *
 *   - `hosted_sites`  — one record per customer site: its globally-unique ipop subdomain + an optional
 *                       custom domain (served only once #264 DNS verification flips `domain_verified`).
 *   - `hosted_pages`  — the pages. A page is rendered to `html` and stored as `draft`, then `pending_approval`
 *                       (parked behind the #13 owner gate — the HARD constraint: nothing goes live without an
 *                       explicit owner approval), then `published` (live, with a cached `public_url`), and is
 *                       reversibly `unpublished`. `approval_request_id` is the load-bearing proof: a page can
 *                       only reach `published` through an approval row.
 *   - `hosted_page_views` — real, recorded view receipts. Page-view metrics are computed ONLY from these
 *                       rows (premortem #200 §2: a metric rests on an external receipt, never self-report).
 *
 * Tenant boundary: `workspace_id` (#3, ON DELETE CASCADE). `approval_request_id` is a SOFT ref (the receipt
 * must outlive a pruned approval). The table names are deliberately NOT `venture_`/`growth_`/`moat_`-
 * prefixed so the #155 colocation gate does not class them as governed metric surfaces.
 */

export const HOSTED_PAGE_KINDS = ["article", "landing"] as const;
export const HOSTED_PAGE_STATUSES = ["draft", "pending_approval", "published", "unpublished"] as const;

export const hostedSites = pgTable(
  "hosted_sites",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subdomain: text("subdomain").notNull(),
    customDomain: text("custom_domain"),
    domainVerified: boolean("domain_verified").notNull().default(false),
    name: text("name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySubdomain: uniqueIndex("hosted_sites_subdomain_uq").on(t.subdomain),
    // A real custom domain is globally unique (one tenant per domain — no hijacking / routing collision);
    // the partial WHERE still lets many sites have no custom domain yet (NULL). Mirrors migration 0266.
    byCustomDomain: uniqueIndex("hosted_sites_custom_domain_uq")
      .on(t.customDomain)
      .where(sql`${t.customDomain} IS NOT NULL`),
    byWorkspace: index("hosted_sites_workspace_idx").on(t.workspaceId),
  }),
);

export const hostedPages = pgTable(
  "hosted_pages",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => hostedSites.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: HOSTED_PAGE_KINDS }).notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: HOSTED_PAGE_STATUSES }).notNull().default("draft"),
    html: text("html"),
    publicUrl: text("public_url"),
    approvalRequestId: uuid("approval_request_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySiteSlug: uniqueIndex("hosted_pages_site_slug_uq").on(t.siteId, t.slug),
    byWorkspace: index("hosted_pages_workspace_idx").on(t.workspaceId),
    kindCk: check("hosted_pages_kind_ck", sql`${t.kind} IN ('article','landing')`),
    statusCk: check(
      "hosted_pages_status_ck",
      sql`${t.status} IN ('draft','pending_approval','published','unpublished')`,
    ),
  }),
);

export const hostedPageViews = pgTable(
  "hosted_page_views",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => hostedPages.id, { onDelete: "cascade" }),
    referrer: text("referrer"),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPage: index("hosted_page_views_page_idx").on(t.pageId, t.viewedAt),
  }),
);
