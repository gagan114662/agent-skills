import { pgTable, uuid, text, boolean, timestamp, jsonb, index, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members, agents } from "./identities.js";

/**
 * A user-defined subagent / agent persona (issue #59, ADR-0036).
 *
 * A persona pairs a reusable **system prompt** + an **allowed-tools ceiling** (+ optional model)
 * with a materialized **agent member** (`kind='agent'`) so it is @-mentionable and runs through every
 * existing path (mentions #6, channels #4, sessions #25, A2A #12) for free. Invoking a persona runs
 * the real harness (#50) **as `agent_member_id`**, scoped to `allowed_tools` — the persona can never
 * exceed that member's own RBAC grants (#9), which is the non-escalation guarantee.
 *
 * Personas carry **no secrets** — only a prompt, tool names, and an optional model. `agent_id` exists
 * so deactivation reuses #9 `deactivateAgent` (a deactivated persona stops resolving as a member).
 */
export const agentPersonas = pgTable(
  "agent_personas",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The @-mentionable member the session runs as / posts as.
    agentMemberId: uuid("agent_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    // The agent profile (for #9 deactivation / token revocation).
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // the @handle (unique per workspace)
    systemPrompt: text("system_prompt").notNull(),
    allowedTools: jsonb("allowed_tools").notNull().default(sql`'[]'::jsonb`),
    model: text("model"),
    isBuiltin: boolean("is_builtin").notNull().default(false),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("agent_personas_workspace_idx").on(t.workspaceId),
    uniqName: unique("agent_personas_workspace_name_uq").on(t.workspaceId, t.name),
  }),
);
