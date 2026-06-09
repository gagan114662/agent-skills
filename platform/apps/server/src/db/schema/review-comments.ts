import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { members } from "./identities.js";
import { agentSessions } from "./agent-sessions.js";
import { pullRequests } from "./pull-requests.js";

/**
 * A review comment on a session's diff (issue #51, ADR-0028). Multiline via `line_start..line_end`
 * and optionally tied to a PR. `delivered_to_session_id` records the follow-up session a comment was
 * forwarded to — the round-trip evidence that a diff comment reached the agent and it ran again to
 * address it. Workspace + channel scoped.
 */
export const reviewComments = pgTable(
  "review_comments",
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
    pullRequestId: uuid("pull_request_id").references(() => pullRequests.id, {
      onDelete: "set null",
    }),
    filePath: text("file_path").notNull(),
    lineStart: integer("line_start"),
    lineEnd: integer("line_end"),
    body: text("body").notNull(),
    authorMemberId: uuid("author_member_id").references(() => members.id, { onDelete: "set null" }),
    deliveredToSessionId: uuid("delivered_to_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byChannel: index("review_comments_channel_idx").on(t.channelId, t.createdAt),
    bySession: index("review_comments_session_idx").on(t.sessionId),
  }),
);
