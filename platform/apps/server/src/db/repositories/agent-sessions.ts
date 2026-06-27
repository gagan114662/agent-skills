import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "../index.js";
import { agentSessions } from "../schema/index.js";
import type { EffortLevel, ProviderKind, SessionMode } from "../../config/schema.js";
import type { HarnessKind } from "../../runtime/harness.js";
import type { AutoModelDecision } from "../../runtime/auto-model.js";

export type { EffortLevel, ProviderKind, SessionMode } from "../../config/schema.js";
export type { HarnessKind } from "../../runtime/harness.js";

/** The persisted auto model-selection "why?" record (convene-llm-gateway routing decision). */
export type SessionSelectionMeta = AutoModelDecision;

/** Lifecycle states of an agent session. Terminal states end with a set `endedAt`. */
export type SessionStatus =
  | "provisioning"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "idle_reaped"
  | "canceled";

export type AgentActivityStatus = "thinking" | "drafting" | "waiting" | "handoff" | "idle" | "done";

export type RuntimeKind = "local" | "sandbox";

/** Resolved per-session resource + wall-clock budget (persisted on the row for audit). */
export interface ResourceCaps {
  wallClockMs: number;
  idleMs: number;
  memoryMb?: number;
}

export interface AgentSession {
  id: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
  createdByMemberId: string | null;
  runtime: RuntimeKind;
  status: SessionStatus;
  agentStatus: AgentActivityStatus;
  command: string;
  idempotencyKey: string | null;
  /** Coding-agent harness the session ran on (#50). Null for rows created before #50. */
  harness: HarnessKind | null;
  sandboxId: string | null;
  snapshotId: string | null;
  exitCode: number | null;
  result: string | null;
  /** Git refs (#51): set when the session runs in a git worktree. Null for non-git sessions. */
  branch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  /** Model/provider selection (#52): the non-secret selection the session ran with. Null = unset. */
  provider: ProviderKind | null;
  model: string | null;
  effort: EffortLevel | null;
  mode: SessionMode | null;
  /**
   * Auto model-selection "why?" (convene-llm-gateway): the routing decision when the model was
   * auto-chosen — which model, why, validation verdict, escalations, cost. Null when not auto-selected.
   */
  selectionMeta: SessionSelectionMeta | null;
  /** Multi-region placement (#71): the region the session ran in. Null = unplaced / local. */
  region: string | null;
  caps: ResourceCaps;
  /** Liveness heartbeat (#105): last proof of progress; null until first output / for pre-#105 rows. */
  lastHeartbeatAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  /** True when createAgentSession returned an existing row for an idempotent launch. */
  reusedIdempotencyKey?: boolean;
}

/** A non-terminal session the #105 watchdog supervises, with its resolved liveness timestamp. */
export interface LiveSessionRow {
  id: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
  createdByMemberId: string | null;
  status: SessionStatus;
  agentStatus: AgentActivityStatus;
  /** COALESCE(last_heartbeat_at, started_at, created_at) — the session's last proof of progress. */
  progressAt: Date;
}

const COLUMNS = {
  id: agentSessions.id,
  workspaceId: agentSessions.workspaceId,
  channelId: agentSessions.channelId,
  agentMemberId: agentSessions.agentMemberId,
  createdByMemberId: agentSessions.createdByMemberId,
  runtime: agentSessions.runtime,
  status: agentSessions.status,
  agentStatus: agentSessions.agentStatus,
  command: agentSessions.command,
  idempotencyKey: agentSessions.idempotencyKey,
  harness: agentSessions.harness,
  sandboxId: agentSessions.sandboxId,
  snapshotId: agentSessions.snapshotId,
  exitCode: agentSessions.exitCode,
  result: agentSessions.result,
  branch: agentSessions.branch,
  baseBranch: agentSessions.baseBranch,
  headSha: agentSessions.headSha,
  provider: agentSessions.provider,
  model: agentSessions.model,
  effort: agentSessions.effort,
  mode: agentSessions.mode,
  selectionMeta: agentSessions.selectionMeta,
  region: agentSessions.region,
  caps: agentSessions.caps,
  lastHeartbeatAt: agentSessions.lastHeartbeatAt,
  startedAt: agentSessions.startedAt,
  endedAt: agentSessions.endedAt,
  createdAt: agentSessions.createdAt,
} as const;

export async function createAgentSession(input: {
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
  createdByMemberId: string;
  runtime: RuntimeKind;
  command: string;
  idempotencyKey?: string | null;
  caps: ResourceCaps;
  /** Coding-agent harness the session ran on (#50); omitted → null (pre-#50 / unselected). */
  harness?: HarnessKind | null;
  /** Non-secret model/provider selection (#52); omitted when no explicit selection was made. */
  provider?: ProviderKind | null;
  model?: string | null;
  effort?: EffortLevel | null;
  mode?: SessionMode | null;
  /** Auto model-selection "why?" record (convene-llm-gateway); omitted when not auto-selected. */
  selectionMeta?: SessionSelectionMeta | null;
  /** Multi-region placement (#71): the region the session was placed in. */
  region?: string | null;
}): Promise<AgentSession> {
  const values = {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    agentMemberId: input.agentMemberId,
    createdByMemberId: input.createdByMemberId,
    runtime: input.runtime,
    command: input.command,
    idempotencyKey: input.idempotencyKey ?? null,
    harness: input.harness ?? null,
    caps: input.caps,
    provider: input.provider ?? null,
    model: input.model ?? null,
    effort: input.effort ?? null,
    mode: input.mode ?? null,
    selectionMeta: input.selectionMeta ?? null,
    region: input.region ?? null,
    status: "provisioning" as const,
  };
  const [row] = await db
    .insert(agentSessions)
    .values(values)
    .onConflictDoNothing({
      target: [agentSessions.workspaceId, agentSessions.idempotencyKey],
    })
    .returning(COLUMNS);
  if (!row && input.idempotencyKey) {
    const [existing] = await db
      .select(COLUMNS)
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.workspaceId, input.workspaceId),
          eq(agentSessions.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) return { ...(existing as AgentSession), reusedIdempotencyKey: true };
  }
  return row as AgentSession;
}

/** Mark the session running and stamp `startedAt`; records the provider sandbox id if any. */
export async function markSessionRunning(id: string, sandboxId?: string): Promise<void> {
  const now = new Date();
  await db
    .update(agentSessions)
    // #105: seed the heartbeat at start so a freshly-running session isn't instantly "stale" before
    // its first output chunk.
    .set({
      status: "running",
      agentStatus: "thinking",
      startedAt: now,
      lastHeartbeatAt: now,
      sandboxId: sandboxId ?? null,
    })
    .where(eq(agentSessions.id, id));
}

/** Bump a session's liveness heartbeat (#105): the SessionManager calls this on every output chunk. */
export async function heartbeatSession(
  id: string,
  at: Date = new Date(),
  agentStatus: AgentActivityStatus = "drafting",
): Promise<void> {
  await db.update(agentSessions).set({ lastHeartbeatAt: at, agentStatus }).where(eq(agentSessions.id, id));
}

/** Finalize a session: terminal status + result/exit/snapshot + `endedAt`. */
export async function finalizeSession(
  id: string,
  fields: {
    status: SessionStatus;
    exitCode?: number | null;
    result?: string | null;
    snapshotId?: string | null;
  },
): Promise<void> {
  await db
    .update(agentSessions)
    .set({
      status: fields.status,
      agentStatus: "done",
      exitCode: fields.exitCode ?? null,
      result: fields.result ?? null,
      snapshotId: fields.snapshotId ?? null,
      endedAt: new Date(),
    })
    .where(eq(agentSessions.id, id));
}

/**
 * Force a session to a terminal state ONLY if it is still live (`provisioning`/`running`) — a race-safe
 * UPDATE used to (a) cancel an orphaned/cross-process session the in-memory manager can no longer reach
 * (#248), and (b) defend the pre-start vanish path. Returns whether a live row was finalized: `false`
 * means the row was already terminal (a concurrent finalize won) or does not exist, so a caller never
 * stomps a `completed` row. The terminal `result` carries the human-readable reason.
 */
export async function forceFinalizeIfLive(
  id: string,
  fields: { status: SessionStatus; result?: string | null; exitCode?: number | null },
): Promise<boolean> {
  const updated = await db
    .update(agentSessions)
    .set({
      status: fields.status,
      agentStatus: "done",
      result: fields.result ?? null,
      exitCode: fields.exitCode ?? null,
      endedAt: new Date(),
    })
    .where(
      and(
        eq(agentSessions.id, id),
        inArray(agentSessions.status, ["provisioning", "running"]),
      ),
    )
    .returning({ id: agentSessions.id });
  return updated.length > 0;
}

/** Record a session's git refs (#51): branch + base + latest committed head sha. Idempotent. */
export async function setSessionGitRefs(
  id: string,
  refs: { branch: string; baseBranch: string; headSha?: string | null },
): Promise<void> {
  await db
    .update(agentSessions)
    .set({ branch: refs.branch, baseBranch: refs.baseBranch, headSha: refs.headSha ?? null })
    .where(eq(agentSessions.id, id));
}

/** Fetch a single session scoped to its channel (prevents cross-channel/tenant reads). */
export async function getAgentSession(
  id: string,
  channelId: string,
): Promise<AgentSession | undefined> {
  const [row] = await db
    .select(COLUMNS)
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.channelId, channelId)))
    .limit(1);
  return row as AgentSession | undefined;
}

/** A session's current lifecycle status by id (#84): the autonomy loop reads it to close the loop. */
export async function getAgentSessionStatus(id: string): Promise<SessionStatus | undefined> {
  const [row] = await db
    .select({ status: agentSessions.status })
    .from(agentSessions)
    .where(eq(agentSessions.id, id))
    .limit(1);
  return row?.status as SessionStatus | undefined;
}

/** A session's finalized output tail (#53): the plan-mode run's proposed plan is parsed from it. */
export async function getAgentSessionResult(id: string): Promise<string | null> {
  const [row] = await db
    .select({ result: agentSessions.result })
    .from(agentSessions)
    .where(eq(agentSessions.id, id))
    .limit(1);
  return row?.result ?? null;
}

/**
 * The fleet's live (non-terminal) sessions across all workspaces — the #105 watchdog's work-list.
 * `progressAt` is the session's last proof of progress (heartbeat, else start, else creation), so the
 * watchdog can age it against the per-workspace stale cutoff. Bounded by live concurrency (indexed on
 * `status`); terminal rows are excluded.
 */
export async function listLiveSessions(): Promise<LiveSessionRow[]> {
  const rows = await db
    .select({
      id: agentSessions.id,
      workspaceId: agentSessions.workspaceId,
      channelId: agentSessions.channelId,
      agentMemberId: agentSessions.agentMemberId,
      createdByMemberId: agentSessions.createdByMemberId,
      status: agentSessions.status,
      agentStatus: agentSessions.agentStatus,
      // A raw COALESCE loses drizzle/pg's timestamptz parser, so the value can come back as a string —
      // coerce to a Date below so callers always get a real Date.
      progressAt: sql<string>`COALESCE(${agentSessions.lastHeartbeatAt}, ${agentSessions.startedAt}, ${agentSessions.createdAt})`,
    })
    .from(agentSessions)
    .where(inArray(agentSessions.status, ["provisioning", "running"]));
  return rows.map((r) => ({ ...r, progressAt: new Date(r.progressAt) })) as LiveSessionRow[];
}

/** One workspace's live (non-terminal) sessions — the #147 mission-control source (tenant-scoped). */
export interface WorkspaceLiveSession {
  id: string;
  channelId: string;
  agentMemberId: string;
  status: SessionStatus;
  agentStatus: AgentActivityStatus;
  /** When the session was created (the elapsed-time anchor when `startedAt` is null). */
  createdAt: Date;
  /** When the session began running, or null (provisioning). */
  startedAt: Date | null;
  /** COALESCE(last_heartbeat_at, started_at, created_at) — the session's last proof of progress. */
  progressAt: Date;
}

export async function listWorkspaceLiveSessions(workspaceId: string): Promise<WorkspaceLiveSession[]> {
  const rows = await db
    .select({
      id: agentSessions.id,
      channelId: agentSessions.channelId,
      agentMemberId: agentSessions.agentMemberId,
      status: agentSessions.status,
      agentStatus: agentSessions.agentStatus,
      createdAt: agentSessions.createdAt,
      startedAt: agentSessions.startedAt,
      progressAt: sql<string>`COALESCE(${agentSessions.lastHeartbeatAt}, ${agentSessions.startedAt}, ${agentSessions.createdAt})`,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.workspaceId, workspaceId),
        inArray(agentSessions.status, ["provisioning", "running"]),
      ),
    )
    .orderBy(desc(agentSessions.createdAt));
  return rows.map((r) => ({ ...r, progressAt: new Date(r.progressAt) })) as WorkspaceLiveSession[];
}

/**
 * A recently-finished or live session as the #230 mission-control diagnostic reads it: enough to
 * classify WHY a session ended (status + exit code + a short result tail) so the console can show the
 * exit reason instead of an indefinite "clocking in". `result` is the already-redacted terminal tail
 * the runtime persisted (never the raw output stream).
 */
export interface RecentWorkspaceSession {
  id: string;
  channelId: string;
  agentMemberId: string;
  status: SessionStatus;
  exitCode: number | null;
  result: string | null;
  endedAt: Date | null;
  createdAt: Date;
}

/**
 * The workspace's most recent sessions (incl. terminal rows), newest first — the #230 diagnostic source.
 * Unlike {@link listWorkspaceLiveSessions} this DELIBERATELY includes finished/failed rows so a
 * spawn-and-die fleet (which leaves zero live rows) is still visible as "21 sessions, all failed (spawn)".
 */
export async function listRecentWorkspaceSessions(
  workspaceId: string,
  limit = 20,
  createdSince?: Date | null,
): Promise<RecentWorkspaceSession[]> {
  const filters = [eq(agentSessions.workspaceId, workspaceId)];
  if (createdSince) filters.push(gte(agentSessions.createdAt, createdSince));
  const rows = await db
    .select({
      id: agentSessions.id,
      channelId: agentSessions.channelId,
      agentMemberId: agentSessions.agentMemberId,
      status: agentSessions.status,
      exitCode: agentSessions.exitCode,
      result: agentSessions.result,
      endedAt: agentSessions.endedAt,
      createdAt: agentSessions.createdAt,
    })
    .from(agentSessions)
    .where(and(...filters))
    .orderBy(desc(agentSessions.createdAt))
    .limit(limit);
  return rows as RecentWorkspaceSession[];
}

/** A single session by id (no channel scope) — mission-control resolves its workspace + channel here. */
export async function getAgentSessionById(id: string): Promise<AgentSession | undefined> {
  const [row] = await db.select(COLUMNS).from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  return row as AgentSession | undefined;
}

/** Sessions for a channel, newest first. */
export async function listAgentSessions(channelId: string): Promise<AgentSession[]> {
  const rows = await db
    .select(COLUMNS)
    .from(agentSessions)
    .where(eq(agentSessions.channelId, channelId))
    .orderBy(desc(agentSessions.createdAt));
  return rows as AgentSession[];
}

const TERMINAL_SESSION_STATUSES: SessionStatus[] = ["completed", "failed", "timeout", "idle_reaped", "canceled"];

/** Delete old terminal sessions in a bounded batch. FKs cascade linked run artifacts/log records. */
export async function pruneTerminalAgentSessionsBefore(cutoff: Date, limit = 500): Promise<string[]> {
  const victims = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(inArray(agentSessions.status, TERMINAL_SESSION_STATUSES), lt(agentSessions.endedAt, cutoff)))
    .orderBy(agentSessions.endedAt)
    .limit(Math.max(1, Math.trunc(limit)));
  const ids = victims.map((row) => row.id);
  if (ids.length === 0) return [];
  const deleted = await db.delete(agentSessions).where(inArray(agentSessions.id, ids)).returning({ id: agentSessions.id });
  return deleted.map((row) => row.id);
}
