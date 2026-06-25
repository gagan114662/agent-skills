import { pgTable, uuid, text, integer, timestamp, jsonb, index, unique, check } from "drizzle-orm/pg-core";
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
    // #1050: lifecycle status says whether the run is alive; agent_status says what the agent is doing now.
    // It is intentionally separate so "running" can render as thinking/drafting/waiting/handoff in the feed.
    agentStatus: text("agent_status", {
      enum: ["thinking", "drafting", "waiting", "handoff", "idle", "done"],
    })
      .notNull()
      .default("idle"),
    command: text("command").notNull(),
    // Optional caller-owned idempotency key. Autonomy uses one key per workflow stage so a restart
    // that retries launch observes the existing live session instead of creating duplicate work.
    idempotencyKey: text("idempotency_key"),
    // Coding-agent harness the session ran on (#50): the per-session selection (env default unless
    // overridden at launch). Nullable — rows created before #50 leave it unset.
    harness: text("harness", { enum: ["demo", "claude-code", "codex"] }),
    sandboxId: text("sandbox_id"),
    snapshotId: text("snapshot_id"),
    exitCode: integer("exit_code"),
    result: text("result"),
    // Git refs (#51): set when the session runs in a git worktree (agent/<id> off base_branch).
    // Nullable — non-git sessions (#25 default) leave them unset.
    branch: text("branch"),
    baseBranch: text("base_branch"),
    headSha: text("head_sha"),
    // Model/provider selection (#52): the non-secret selection a session ran with (audit + review UI).
    // Nullable — a session launched without explicit selection (or on demo) leaves them unset.
    // Credentials NEVER live here; they stay on the #25 SecretsResolver path.
    provider: text("provider", { enum: ["anthropic", "openai", "bedrock", "vertex", "custom"] }),
    model: text("model"),
    effort: text("effort", { enum: ["off", "low", "medium", "high"] }),
    mode: text("mode", { enum: ["single", "auto"] }),
    // Auto model-selection "why?" (convene-llm-gateway): when the model was auto-chosen, the routing
    // decision — chosen model, stage, rationale, validation verdict, escalations, cost. The owner's
    // line-of-control audit surface. Null when no auto selection ran. Secret-free + prompt-free.
    selectionMeta: jsonb("selection_meta"),
    // Multi-region placement (#71): the region the session was placed in. Nullable — local/unplaced
    // sessions (#25 default) leave it unset.
    region: text("region"),
    caps: jsonb("caps").notNull().default(sql`'{}'::jsonb`),
    // Liveness heartbeat (#105): bumped by the SessionManager on every output chunk (the same signal
    // the in-process idle-reaper trusts). The Fleet Watchdog flags a non-terminal session whose
    // heartbeat is older than its `staleCutoffMs`. Null for rows created before #105 / never streamed —
    // staleness falls back to COALESCE(last_heartbeat_at, started_at, created_at).
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("agent_sessions_workspace_idx").on(t.workspaceId),
    byChannel: index("agent_sessions_channel_idx").on(t.channelId, t.createdAt),
    byStatus: index("agent_sessions_status_idx").on(t.status),
    idempotencyUniq: unique("agent_sessions_workspace_idempotency_uniq").on(
      t.workspaceId,
      t.idempotencyKey,
    ),
    // #105: the watchdog scans non-terminal sessions ordered by liveness — a partial-ish index on
    // (status, last_heartbeat_at) keeps that scan cheap.
    byHeartbeat: index("agent_sessions_heartbeat_idx").on(t.status, t.lastHeartbeatAt),
    runtimeCk: check("agent_sessions_runtime_ck", sql`${t.runtime} IN ('local', 'sandbox')`),
    harnessCk: check(
      "agent_sessions_harness_ck",
      sql`${t.harness} IS NULL OR ${t.harness} IN ('demo', 'claude-code', 'codex')`,
    ),
    statusCk: check(
      "agent_sessions_status_ck",
      sql`${t.status} IN ('provisioning', 'running', 'completed', 'failed', 'timeout', 'idle_reaped', 'canceled')`,
    ),
    agentStatusCk: check(
      "agent_sessions_agent_status_ck",
      sql`${t.agentStatus} IN ('thinking', 'drafting', 'waiting', 'handoff', 'idle', 'done')`,
    ),
  }),
);
