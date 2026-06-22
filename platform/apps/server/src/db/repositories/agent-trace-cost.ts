import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "../index.js";
import { agentTraceRuns } from "../schema/index.js";
import type { RunCostRow } from "../../observability/cost/rollup.js";

/**
 * Read-only cost queries over the #560 trace tables (issue #667). Separate from `agent-trace.ts` so the cost
 * module owns its own read path without touching the trace repo. Workspace-scoped (#3 IDOR). No schema of its
 * own — it reads the already-persisted `agent_trace_runs` rollup columns, so there is no migration here.
 */

/** Hard ceiling on a window scan so a huge workspace can't pull an unbounded result set into memory. */
export const RUN_COST_WINDOW_CAP = 5000;

const COST_RUN_COLS = {
  id: agentTraceRuns.id,
  agentMemberId: agentTraceRuns.agentMemberId,
  label: agentTraceRuns.label,
  sessionId: agentTraceRuns.sessionId,
  inputTokens: agentTraceRuns.inputTokens,
  outputTokens: agentTraceRuns.outputTokens,
  costMicros: agentTraceRuns.costMicros,
  startedAt: agentTraceRuns.startedAt,
};

/** A single run header reduced to cost fields, scoped to the workspace. */
export async function getRunCostRow(
  workspaceId: string,
  runId: string,
): Promise<RunCostRow | undefined> {
  const [row] = await db
    .select(COST_RUN_COLS)
    .from(agentTraceRuns)
    .where(and(eq(agentTraceRuns.workspaceId, workspaceId), eq(agentTraceRuns.id, runId)))
    .limit(1);
  return row as RunCostRow | undefined;
}

/**
 * Run headers (cost fields) within an optional `[since, until]` window, newest first, scoped to the workspace.
 * `limit` is clamped to `[1, RUN_COST_WINDOW_CAP]`. Used to drive the per-agent and per-day rollups.
 */
export async function listRunCostRows(
  workspaceId: string,
  window: { since?: Date; until?: Date; limit?: number } = {},
): Promise<RunCostRow[]> {
  const conds = [eq(agentTraceRuns.workspaceId, workspaceId)];
  if (window.since) conds.push(gte(agentTraceRuns.startedAt, window.since));
  if (window.until) conds.push(lte(agentTraceRuns.startedAt, window.until));
  const limit = Math.max(1, Math.min(RUN_COST_WINDOW_CAP, window.limit ?? RUN_COST_WINDOW_CAP));
  return db
    .select(COST_RUN_COLS)
    .from(agentTraceRuns)
    .where(and(...conds))
    .orderBy(desc(agentTraceRuns.startedAt))
    .limit(limit) as Promise<RunCostRow[]>;
}
