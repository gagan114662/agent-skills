import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { members } from "./identities.js";
import { agentSessions } from "./agent-sessions.js";

/**
 * A plan proposed by an agent in plan mode (issue #53, ADR-0030).
 *
 * `propose` launches a plan-mode session (`AGENT_PLAN_MODE=1`) that emits a plan and does NO work;
 * its output is parsed into `plan_text` and a `proposed` row lands here. Work BLOCKS until a human
 * decides: `approve` / `approve_with_feedback` (the note is threaded into the execution task) /
 * `reject`. On approval the execution session is launched and stamped on `execution_session_id`.
 * Workspace + channel scoped like every #25-era row; carries no secrets.
 */
export const planProposals = pgTable(
  "plan_proposals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    agentMemberId: uuid("agent_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    // The plan-mode run that proposed it (set null if that session row is later removed).
    planSessionId: uuid("plan_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    originalTask: text("original_task").notNull(),
    planText: text("plan_text").notNull(),
    status: text("status", {
      enum: ["proposed", "approved", "approved_with_feedback", "rejected"],
    })
      .notNull()
      .default("proposed"),
    feedback: text("feedback"),
    // The execution session launched on approval (null until/unless approved).
    executionSessionId: uuid("execution_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    decidedByMemberId: uuid("decided_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => ({
    byChannel: index("plan_proposals_channel_idx").on(t.channelId, t.createdAt),
    statusCk: check(
      "plan_proposals_status_ck",
      sql`${t.status} IN ('proposed', 'approved', 'approved_with_feedback', 'rejected')`,
    ),
  }),
);
