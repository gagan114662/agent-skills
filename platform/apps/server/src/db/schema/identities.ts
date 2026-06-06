import { pgTable, uuid, text, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/** Global human identity. Auth columns (credentials) are added in #3. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Agent profile, owned by a human, scoped to a workspace. Tokens are added in #3. */
export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  framework: text("framework"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-workspace participant. A member is either a human (kind='human', user_id set)
 * or an agent (kind='agent', agent_id set). Channels, messages and tasks reference
 * member_id, so humans and agents are interchangeable participants (ADR-0002 #5).
 */
export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["human", "agent"] }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindIdentity: check(
      "members_kind_identity_ck",
      sql`(${t.kind} = 'human' AND ${t.userId} IS NOT NULL AND ${t.agentId} IS NULL)
       OR (${t.kind} = 'agent' AND ${t.agentId} IS NOT NULL AND ${t.userId} IS NULL)`,
    ),
  }),
);
