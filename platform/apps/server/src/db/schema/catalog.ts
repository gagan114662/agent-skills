import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";

/**
 * Workspace catalog persistence (#152, ADR-0152). A structured registry of the workspace's marketing
 * assets (sites, brand kit, social accounts, email domains, ad accounts, analytics properties,
 * ventures, deployed apps). Agents read it for context instead of re-asking the owner; workflows read
 * its rows as facts for their conditions. One workspace-scoped table — `workspace_id` carries the #3
 * tenant boundary on every read. `owner_member_id` is nullable (an asset may be unowned).
 */

export const CATALOG_KINDS = [
  "site",
  "brand_kit",
  "social_account",
  "email_domain",
  "ad_account",
  "analytics_property",
  "venture",
  "deployed_app",
  "repo",
  "other",
] as const;
export const CATALOG_STATUSES = ["active", "inactive", "pending", "archived"] as const;
export const CATALOG_PROVENANCES = ["manual", "synced", "agent"] as const;

export const catalogEntries = pgTable(
  "catalog_entries",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: CATALOG_KINDS }).notNull(),
    name: text("name").notNull(),
    /** The canonical handle/URL (e.g. `https://ipop.ai`, `@ipop`, `ipop.ai`). */
    identifier: text("identifier").notNull().default(""),
    status: text("status", { enum: CATALOG_STATUSES }).notNull().default("active"),
    /** How this row got here: `manual` (owner), `synced` (an integration), `agent` (a fleet agent). */
    provenance: text("provenance", { enum: CATALOG_PROVENANCES }).notNull().default("manual"),
    /** The member who owns the asset (nullable — an asset can be unowned). */
    ownerMemberId: uuid("owner_member_id").references(() => members.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
    createdByMemberId: uuid("created_by_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("catalog_entries_workspace_idx").on(t.workspaceId),
    byWorkspaceKind: index("catalog_entries_workspace_kind_idx").on(t.workspaceId, t.kind),
  }),
);
