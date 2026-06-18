import { pgTable, uuid, text, integer, boolean, timestamp, index, unique } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Enterprise per-agent + per-customer usage metering ledger (#340, ADR-0340). One row per metered use of a
 * model / tool / governed action by a department agent — the verifiable receipt the cost-control + billing
 * surfaces read. Tenant boundary: `workspace_id` (#3, ON DELETE CASCADE).
 *
 * Premortem #200 §2: a row is `verified` only when `external_ref` is present (a provider receipt). The flag is
 * DERIVED at write time by the service, never client-asserted. Holds NO secret — only structural metering.
 * The table is deliberately NOT `tenant_usage*`/`growth_`/`venture_`-prefixed so the #155 colocation gate does
 * not class it as a governed metric surface (it is operational metering — like `provisioning_usage`).
 */
export const enterpriseUsage = pgTable(
  "enterprise_usage",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The department agent / persona that used the resource (the per-agent dimension). */
    agentId: text("agent_id").notNull(),
    /** `model` | `tool` | `action`. */
    kind: text("kind").notNull(),
    /** Model id / tool name / action type — sanitized (untrusted free text), never a secret. */
    resource: text("resource").notNull(),
    /** The provider that emitted the receipt (sanitized), or NULL for an internal estimate. */
    provider: text("provider"),
    units: integer("units").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    /** Provider receipt / request id proving the call happened (NULL ⇒ UNVERIFIED estimate). */
    externalRef: text("external_ref"),
    /** Derived from `external_ref` presence at write time (premortem §2) — never client-asserted. */
    verified: boolean("verified").notNull().default(false),
    /** A deterministic content handle (provenance hash) the service computes. */
    receiptId: text("receipt_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index("enterprise_usage_workspace_idx").on(t.workspaceId, t.occurredAt),
    agentIdx: index("enterprise_usage_agent_idx").on(t.workspaceId, t.agentId),
  }),
);

/** A persisted usage row as read back. */
export type EnterpriseUsageRow = typeof enterpriseUsage.$inferSelect;

/**
 * Enterprise budget caps (#340, ADR-0340). The pre-committed per-customer (`scope='customer'`, subject =
 * workspace id) and per-agent (`scope='agent'`, subject = agent id) hard spend ceilings the system never
 * crosses, plus the committed-so-far counter. Unique on `(workspace_id, scope, subject_id)`. Tenant boundary:
 * `workspace_id` (#3, ON DELETE CASCADE). This holds the caps that back bid's money caps.
 */
export const enterpriseBudgetCaps = pgTable(
  "enterprise_budget_caps",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** `customer` | `agent`. */
    scope: text("scope").notNull(),
    /** The workspace id (customer scope) or the agent id (agent scope) the cap applies to. */
    subjectId: text("subject_id").notNull(),
    /** The hard ceiling (cents) the committed total may never exceed. */
    capCents: integer("cap_cents").notNull().default(0),
    /** Cents committed against the cap so far. */
    committedCents: integer("committed_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subjectUnique: unique("enterprise_budget_caps_subject_unique").on(t.workspaceId, t.scope, t.subjectId),
  }),
);

/** A persisted budget cap row. */
export type EnterpriseBudgetCapRow = typeof enterpriseBudgetCaps.$inferSelect;
