import { pgTable, uuid, text, integer, timestamp, index, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { members } from "./identities.js";
import { messages } from "./messages.js";
import { agentSessions } from "./agent-sessions.js";
import { planProposals } from "./plan-proposals.js";

/**
 * A session's checkpoint ledger (issue #53, ADR-0030).
 *
 * Each row is one **turn** (a checkpoint) on a session's #51 worktree branch: `idx` orders them,
 * `idx 0` is the **baseline** (the state before any work). `head_sha` is the committed worktree
 * snapshot (the FILES half) and `cursor_message_id` is the channel's latest message at capture (the
 * CONVERSATION half). Reverting turn T resets the worktree to the previous checkpoint's `head_sha`
 * and soft-deletes messages after its `cursor_message_id`, then marks the discarded turns
 * `reverted_at` — chat and working tree return together. Workspace + channel scoped.
 */
export const sessionTurns = pgTable(
  "session_turns",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    kind: text("kind", { enum: ["baseline", "work"] })
      .notNull()
      .default("work"),
    headSha: text("head_sha"),
    cursorMessageId: uuid("cursor_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    planProposalId: uuid("plan_proposal_id").references(() => planProposals.id, {
      onDelete: "set null",
    }),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySession: index("session_turns_session_idx").on(t.sessionId, t.idx),
    sessionIdxUq: unique("session_turns_session_idx_uq").on(t.sessionId, t.idx),
    kindCk: check("session_turns_kind_ck", sql`${t.kind} IN ('baseline', 'work')`),
  }),
);
