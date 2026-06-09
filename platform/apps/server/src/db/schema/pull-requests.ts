import { pgTable, uuid, text, integer, boolean, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { members } from "./identities.js";
import { agentSessions } from "./agent-sessions.js";

/**
 * A pull request opened from an agent session's branch (issue #51, ADR-0028).
 *
 * The `number`/`url` come from the {@link GitHubProvider}; the `none` provider cannot create a PR
 * (the route returns 501), so a persisted row always carries them. `checks_status` mirrors GitHub
 * CI as it is refreshed. Workspace + channel scoped, like every #25-era row.
 */
export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    number: integer("number"),
    url: text("url"),
    title: text("title").notNull(),
    body: text("body"),
    draft: boolean("draft").notNull().default(false),
    state: text("state", { enum: ["draft", "open", "merged", "closed"] })
      .notNull()
      .default("open"),
    checksStatus: text("checks_status", { enum: ["unknown", "pending", "success", "failure"] })
      .notNull()
      .default("unknown"),
    baseBranch: text("base_branch").notNull(),
    headBranch: text("head_branch").notNull(),
    provider: text("provider", { enum: ["none", "gh"] })
      .notNull()
      .default("none"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byChannel: index("pull_requests_channel_idx").on(t.channelId, t.createdAt),
    bySession: index("pull_requests_session_idx").on(t.sessionId),
    stateCk: check(
      "pull_requests_state_ck",
      sql`${t.state} IN ('draft', 'open', 'merged', 'closed')`,
    ),
    checksCk: check(
      "pull_requests_checks_ck",
      sql`${t.checksStatus} IN ('unknown', 'pending', 'success', 'failure')`,
    ),
    providerCk: check("pull_requests_provider_ck", sql`${t.provider} IN ('none', 'gh')`),
  }),
);
