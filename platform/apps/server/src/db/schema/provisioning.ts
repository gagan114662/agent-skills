import { pgTable, uuid, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Central-provisioning usage ledger (#267, ADR-0267). One row per use of a centrally-provisioned paid API
 * (keyword/SERP data, social posting, ads management) — this is how ipop "bills the cost of goods into the
 * plan". The per-department adapters (#265/#268/#269/#270/#272) write one row per call via the
 * `ProvisioningService.meter` seam.
 *
 * Tenant boundary: `workspace_id` (#3, ON DELETE CASCADE). The table is deliberately NOT
 * venture_/growth_/demand_/moat_-prefixed, so the #155 colocation gate does not class it as a governed
 * metric surface (it is operational metering, not a reported metric). Holds NO secret — only the structural
 * provider id, units, cost of goods, and an OPTIONAL external receipt reference. Premortem #200 §2: a row
 * is `verified` only when `external_ref` is present; the billing read sums only verified rows.
 */
export const provisioningUsage = pgTable(
  "provisioning_usage",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The capability id from the catalog (e.g. `keyword_data`, `serp_data`, `social_post`). */
    capabilityId: text("capability_id").notNull(),
    /** The structural provider id that served the call — never a key. */
    provider: text("provider").notNull(),
    /** Billable units the call consumed (API calls / rows / posts). */
    units: integer("units").notNull().default(0),
    /** Cost of goods (cents) ipop incurred — billed into the plan, not charged per call to the customer. */
    costCents: integer("cost_cents").notNull().default(0),
    /** Provider receipt / request id proving the call happened (NULL ⇒ the row is an UNVERIFIED estimate). */
    externalRef: text("external_ref"),
    /** Derived from `external_ref` presence at write time (premortem §2) — never client-asserted. */
    verified: boolean("verified").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index("provisioning_usage_workspace_idx").on(t.workspaceId, t.occurredAt),
    capabilityIdx: index("provisioning_usage_capability_idx").on(t.workspaceId, t.capabilityId),
  }),
);

/** A persisted usage row as read back (timestamps as ms are derived in the repo, not here). */
export type ProvisioningUsageRow = typeof provisioningUsage.$inferSelect;
