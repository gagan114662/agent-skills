import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { members } from "./identities.js";

/**
 * Marketing department task records (issue #123, ADR-0123).
 *
 * A durable record of REAL work the marketing fleet does: each welcome brief and each @mention launch
 * becomes a row tying the channel + agent + the launched #25 session + (for a mention) its source
 * message. It materializes "task records posted back to the channel" and powers the team panel's
 * per-agent activity. `session_id` / `message_id` are **soft** references (no FK) so a task record
 * outlives pruned session/message history; only `workspace_id` carries the #3 tenant boundary.
 */
export const marketingTasks = pgTable(
  "marketing_tasks",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    department: text("department").notNull(),
    agentMemberId: uuid("agent_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    // Soft references (no FK) — the record outlives pruned session/message history.
    sessionId: uuid("session_id"),
    messageId: uuid("message_id"),
    kind: text("kind").notNull(), // 'welcome' | 'mention'
    task: text("task").notNull(),
    status: text("status").notNull().default("launched"), // 'launched' | 'done' | 'failed' | 'blocked'
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("marketing_tasks_workspace_idx").on(t.workspaceId, t.createdAt),
    byAgent: index("marketing_tasks_agent_idx").on(t.workspaceId, t.agentMemberId),
  }),
);
