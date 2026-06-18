import { pgTable, uuid, text, timestamp, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Agent Garden per-workspace enable state (#284, ADR-0284). One workspace-scoped table,
 * `garden_agent_enablements`: the durable record of which department agents the owner has switched on (or
 * is awaiting approval to switch on) in a workspace. One row per (workspace, agent handle).
 *
 * The displayed on/off the owner sees is NOT this row alone — `projectGardenView` reconciles it against the
 * production-grounded persona-presence fact (premortem #200 FM#3). This table just holds the owner's intent;
 * an absent row means `disabled` (default OFF). It carries NO metric and NO credential.
 *
 * The table name is deliberately `garden_*` (not `growth_`/`demand_`/`venture_`/`moat_`) so the #155
 * colocation gate does not class it as a governed metric surface. No FK beyond the tenant boundary (#3).
 */

export const GARDEN_AGENT_STATE_VALUES = ["enabled", "pending_approval", "disabled"] as const;

export const gardenAgentEnablements = pgTable(
  "garden_agent_enablements",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The @-mentionable fleet persona handle (lowercase), e.g. `scout`. */
    handle: text("handle").notNull(),
    /** The owner's enable intent for this agent (`enabled` | `pending_approval` | `disabled`). */
    state: text("state", { enum: GARDEN_AGENT_STATE_VALUES }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceHandle: unique("garden_agent_enablements_workspace_handle_unique").on(
      t.workspaceId,
      t.handle,
    ),
    stateCk: check(
      "garden_agent_enablements_state_ck",
      sql`${t.state} IN ('enabled','pending_approval','disabled')`,
    ),
  }),
);
