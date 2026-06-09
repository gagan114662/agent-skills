import { pgTable, uuid, text, integer, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { members } from "./identities.js";

/**
 * A server-owned agent run on an AgentRuntime backend (issue #25, ADR-0025).
 *
 * The row is created at launch (`provisioning`), advanced by the SessionManager through its
 * lifecycle, and finalized at teardown. It (and the messages the session streams into the
 * channel) outlive any client connection — that is what makes "close the laptop, agents keep
 * working" real. `caps` is the resolved per-session resource/wall-clock budget; `result` is a
 * terminal summary/output tail and MUST never contain secrets.
 */
export const agentSessions = pgTable(
  "agent_sessions",
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
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    runtime: text("runtime", { enum: ["local", "sandbox"] }).notNull(),
    status: text("status", {
      enum: [
        "provisioning",
        "running",
        "completed",
        "failed",
        "timeout",
        "idle_reaped",
        "canceled",
      ],
    })
      .notNull()
      .default("provisioning"),
    command: text("command").notNull(),
    sandboxId: text("sandbox_id"),
    snapshotId: text("snapshot_id"),
    exitCode: integer("exit_code"),
    result: text("result"),
    // Git refs (#51): set when the session runs in a git worktree (agent/<id> off base_branch).
    // Nullable — non-git sessions (#25 default) leave them unset.
    branch: text("branch"),
    baseBranch: text("base_branch"),
    headSha: text("head_sha"),
    caps: jsonb("caps").notNull().default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("agent_sessions_workspace_idx").on(t.workspaceId),
    byChannel: index("agent_sessions_channel_idx").on(t.channelId, t.createdAt),
    byStatus: index("agent_sessions_status_idx").on(t.status),
    runtimeCk: check("agent_sessions_runtime_ck", sql`${t.runtime} IN ('local', 'sandbox')`),
    statusCk: check(
      "agent_sessions_status_ck",
      sql`${t.status} IN ('provisioning', 'running', 'completed', 'failed', 'timeout', 'idle_reaped', 'canceled')`,
    ),
  }),
);
