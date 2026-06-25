import { pgTable, uuid, text, boolean, timestamp, primaryKey, check, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

export const WORKSPACE_RUNTIME_CAPABILITIES = ["marketing", "onboarding", "realworld"] as const;

/**
 * Runtime, tenant-scoped capability toggles (#871). These rows are deliberately narrow: they override only
 * the customer-facing enabled bit for self-serve activation surfaces. Provider choices, owners, limits, and
 * other safety-sensitive knobs stay in env/managed config.
 */
export const workspaceCapabilities = pgTable(
  "workspace_capabilities",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    capability: text("capability", { enum: WORKSPACE_RUNTIME_CAPABILITIES }).notNull(),
    enabled: boolean("enabled").notNull(),
    updatedByMemberId: uuid("updated_by_member_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.capability] }),
    byWorkspace: index("workspace_capabilities_workspace_idx").on(t.workspaceId, t.updatedAt),
    capabilityCk: check(
      "workspace_capabilities_capability_ck",
      sql`${t.capability} IN ('marketing','onboarding','realworld')`,
    ),
  }),
);

