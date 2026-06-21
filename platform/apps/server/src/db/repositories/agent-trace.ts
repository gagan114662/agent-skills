import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import { agentTraceRuns, agentTraceEvents } from "../schema/index.js";
import type { AgentTraceEventType, AgentTraceRunStatus } from "../schema/agent-trace.js";

/**
 * Observation/replay trace repository (issue #560). Workspace-scoped (#3 IDOR discipline). The event log is
 * append-only: events are inserted, never updated. Per-event `seq` is assigned atomically by bumping the
 * run header's `next_seq` inside the same transaction as the insert, so concurrent appends to one run get
 * strictly increasing, gap-free ordering and the token/cost rollup stays consistent. All
 * redaction/sanitization lives in `trace/*` + the service — this layer is pure persistence.
 */

export interface AgentTraceRunRow {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  agentMemberId: string | null;
  taskId: string | null;
  label: string | null;
  status: AgentTraceRunStatus;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  startedAt: Date;
  endedAt: Date | null;
}

export interface AgentTraceEventRow {
  id: string;
  runId: string;
  workspaceId: string;
  seq: number;
  type: AgentTraceEventType;
  turn: number;
  label: string | null;
  payload: Record<string, unknown>;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  occurredAt: Date;
}

const RUN_COLS = {
  id: agentTraceRuns.id,
  workspaceId: agentTraceRuns.workspaceId,
  sessionId: agentTraceRuns.sessionId,
  agentMemberId: agentTraceRuns.agentMemberId,
  taskId: agentTraceRuns.taskId,
  label: agentTraceRuns.label,
  status: agentTraceRuns.status,
  eventCount: agentTraceRuns.eventCount,
  inputTokens: agentTraceRuns.inputTokens,
  outputTokens: agentTraceRuns.outputTokens,
  costMicros: agentTraceRuns.costMicros,
  startedAt: agentTraceRuns.startedAt,
  endedAt: agentTraceRuns.endedAt,
};

const EVENT_COLS = {
  id: agentTraceEvents.id,
  runId: agentTraceEvents.runId,
  workspaceId: agentTraceEvents.workspaceId,
  seq: agentTraceEvents.seq,
  type: agentTraceEvents.type,
  turn: agentTraceEvents.turn,
  label: agentTraceEvents.label,
  payload: agentTraceEvents.payload,
  inputTokens: agentTraceEvents.inputTokens,
  outputTokens: agentTraceEvents.outputTokens,
  costMicros: agentTraceEvents.costMicros,
  occurredAt: agentTraceEvents.occurredAt,
};

export interface OpenTraceRunInput {
  workspaceId: string;
  sessionId?: string | null;
  agentMemberId?: string | null;
  taskId?: string | null;
  label?: string | null;
}

/** Open a trace run header. Returns its id. */
export async function openTraceRun(input: OpenTraceRunInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(agentTraceRuns)
    .values({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId ?? null,
      agentMemberId: input.agentMemberId ?? null,
      taskId: input.taskId ?? null,
      label: input.label ?? null,
    })
    .returning({ id: agentTraceRuns.id });
  return { id: row!.id };
}

export interface AppendTraceEventInput {
  runId: string;
  workspaceId: string;
  type: AgentTraceEventType;
  turn: number;
  label: string | null;
  payload: Record<string, unknown>;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  occurredAt: Date;
}

/**
 * Append one event to a run's append-only log. Atomic: locks the run header (UPDATE … RETURNING),
 * assigns the next `seq`, rolls up the token/cost totals + event count, and inserts the event with that
 * seq — all in one transaction. The run must be in `workspaceId` (the #3 scope) or this is a no-op throw.
 */
export async function appendTraceEvent(
  input: AppendTraceEventInput,
): Promise<{ id: string; seq: number }> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .update(agentTraceRuns)
      .set({
        nextSeq: sql`${agentTraceRuns.nextSeq} + 1`,
        eventCount: sql`${agentTraceRuns.eventCount} + 1`,
        inputTokens: sql`${agentTraceRuns.inputTokens} + ${input.inputTokens ?? 0}`,
        outputTokens: sql`${agentTraceRuns.outputTokens} + ${input.outputTokens ?? 0}`,
        costMicros: sql`${agentTraceRuns.costMicros} + ${input.costMicros ?? 0}`,
      })
      .where(
        and(
          eq(agentTraceRuns.id, input.runId),
          eq(agentTraceRuns.workspaceId, input.workspaceId),
        ),
      )
      .returning({ nextSeq: agentTraceRuns.nextSeq });
    if (!run) throw new Error("trace run not found in workspace");
    const seq = run.nextSeq - 1;

    const [event] = await tx
      .insert(agentTraceEvents)
      .values({
        runId: input.runId,
        workspaceId: input.workspaceId,
        seq,
        type: input.type,
        turn: input.turn,
        label: input.label,
        payload: input.payload,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costMicros: input.costMicros,
        occurredAt: input.occurredAt,
      })
      .returning({ id: agentTraceEvents.id });
    return { id: event!.id, seq };
  });
}

/** Mark a run closed (terminal). Idempotent; scoped to the workspace. */
export async function closeTraceRun(workspaceId: string, runId: string): Promise<void> {
  await db
    .update(agentTraceRuns)
    .set({ status: "closed", endedAt: new Date() })
    .where(and(eq(agentTraceRuns.workspaceId, workspaceId), eq(agentTraceRuns.id, runId)));
}

/** A run header by id, scoped to the workspace (undefined if absent or cross-workspace). */
export async function getTraceRun(
  workspaceId: string,
  runId: string,
): Promise<AgentTraceRunRow | undefined> {
  const [row] = await db
    .select(RUN_COLS)
    .from(agentTraceRuns)
    .where(and(eq(agentTraceRuns.workspaceId, workspaceId), eq(agentTraceRuns.id, runId)))
    .limit(1);
  return row as AgentTraceRunRow | undefined;
}

/** A run's events in replay (seq) order, scoped to the workspace. */
export async function listTraceEvents(
  workspaceId: string,
  runId: string,
): Promise<AgentTraceEventRow[]> {
  return db
    .select(EVENT_COLS)
    .from(agentTraceEvents)
    .where(
      and(eq(agentTraceEvents.workspaceId, workspaceId), eq(agentTraceEvents.runId, runId)),
    )
    .orderBy(asc(agentTraceEvents.seq)) as Promise<AgentTraceEventRow[]>;
}

/** List a workspace's trace runs, newest first. `limit` capped at 200 (default 50). */
export async function listTraceRuns(
  workspaceId: string,
  filter: { sessionId?: string; limit?: number } = {},
): Promise<AgentTraceRunRow[]> {
  const conds = [eq(agentTraceRuns.workspaceId, workspaceId)];
  if (filter.sessionId) conds.push(eq(agentTraceRuns.sessionId, filter.sessionId));
  return db
    .select(RUN_COLS)
    .from(agentTraceRuns)
    .where(and(...conds))
    .orderBy(desc(agentTraceRuns.startedAt))
    .limit(Math.max(1, Math.min(200, filter.limit ?? 50))) as Promise<AgentTraceRunRow[]>;
}
