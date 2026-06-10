import { pgTable, uuid, text, integer, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Per-tenant cloud-scale usage accounting (issue #71, ADR-0040).
 *
 * One row per (tenant, billing window) — the window is a UTC calendar month (`YYYY-MM`). The
 * SessionManager upsert-increments `sessions_started` at launch and `compute_seconds` +
 * `estimated_cost_cents` at teardown. The admission chokepoint reads the current window's
 * `estimated_cost_cents` and compares it against the tenant's configured `budgetCents` (config,
 * #58) to decide whether to halt new sessions. This table is runtime STATE; the cap is POLICY and
 * lives in config — keeping them separate is what lets an operator raise a budget without a migration.
 */
export const tenantUsage = pgTable(
  "tenant_usage",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    windowKey: text("window_key").notNull(),
    sessionsStarted: integer("sessions_started").notNull().default(0),
    computeSeconds: integer("compute_seconds").notNull().default(0),
    estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.windowKey] }),
    byWorkspace: index("tenant_usage_workspace_idx").on(t.workspaceId),
  }),
);
