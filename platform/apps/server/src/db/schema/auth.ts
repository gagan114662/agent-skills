import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { users } from "./identities.js";
import { agents } from "./identities.js";
import { workspaces } from "./workspaces.js";

/** Server-side, revocable human sessions. We store only the SHA-256 hash of the token. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byUser: index("sessions_user_idx").on(t.userId) }),
);

/** Scoped, revocable agent API tokens. Stored as SHA-256 hash; raw shown once at creation. */
export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({ byAgent: index("agent_tokens_agent_idx").on(t.agentId) }),
);
