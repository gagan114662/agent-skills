import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { agentSessions } from "../schema/index.js";

/** Lifecycle states of an agent session. Terminal states end with a set `endedAt`. */
export type SessionStatus =
  | "provisioning"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "idle_reaped"
  | "canceled";

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
  command: string;
  sandboxId: string | null;
  snapshotId: string | null;
  exitCode: number | null;
  result: string | null;
  caps: ResourceCaps;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

const COLUMNS = {
  id: agentSessions.id,
  workspaceId: agentSessions.workspaceId,
  channelId: agentSessions.channelId,
  agentMemberId: agentSessions.agentMemberId,
  createdByMemberId: agentSessions.createdByMemberId,
  runtime: agentSessions.runtime,
  status: agentSessions.status,
  command: agentSessions.command,
  sandboxId: agentSessions.sandboxId,
  snapshotId: agentSessions.snapshotId,
  exitCode: agentSessions.exitCode,
  result: agentSessions.result,
  caps: agentSessions.caps,
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
  caps: ResourceCaps;
}): Promise<AgentSession> {
  const [row] = await db
    .insert(agentSessions)
    .values({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.agentMemberId,
      createdByMemberId: input.createdByMemberId,
      runtime: input.runtime,
      command: input.command,
      caps: input.caps,
      status: "provisioning",
    })
    .returning(COLUMNS);
  return row as AgentSession;
}

/** Mark the session running and stamp `startedAt`; records the provider sandbox id if any. */
export async function markSessionRunning(id: string, sandboxId?: string): Promise<void> {
  await db
    .update(agentSessions)
    .set({ status: "running", startedAt: new Date(), sandboxId: sandboxId ?? null })
    .where(eq(agentSessions.id, id));
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
      exitCode: fields.exitCode ?? null,
      result: fields.result ?? null,
      snapshotId: fields.snapshotId ?? null,
      endedAt: new Date(),
    })
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

/** Sessions for a channel, newest first. */
export async function listAgentSessions(channelId: string): Promise<AgentSession[]> {
  const rows = await db
    .select(COLUMNS)
    .from(agentSessions)
    .where(eq(agentSessions.channelId, channelId))
    .orderBy(desc(agentSessions.createdAt));
  return rows as AgentSession[];
}
