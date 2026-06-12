import { desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { selfqaRuns } from "../schema/index.js";
import type { QaRunSummary, QaSuite } from "../../selfqa/types.js";

/**
 * Self-QA run repository (#171, ADR-0171 §5). Workspace-scoped throughout (the #3 IDOR discipline) — every
 * row lives under the dedicated SYNTHETIC workspace, never a real tenant. Persistence only: the runner /
 * classifier do the work, this records the run-history audit trail read by the #104 founder console.
 */

export interface SelfqaRunRecord {
  id: string;
  workspaceId: string;
  suite: QaSuite;
  target: string;
  status: "running" | "passed" | "failed";
  checksTotal: number;
  checksFailed: number;
  criticalCount: number;
  startedAt: Date;
  finishedAt: Date | null;
}

const COLS = {
  id: selfqaRuns.id,
  workspaceId: selfqaRuns.workspaceId,
  suite: selfqaRuns.suite,
  target: selfqaRuns.target,
  status: selfqaRuns.status,
  checksTotal: selfqaRuns.checksTotal,
  checksFailed: selfqaRuns.checksFailed,
  criticalCount: selfqaRuns.criticalCount,
  startedAt: selfqaRuns.startedAt,
  finishedAt: selfqaRuns.finishedAt,
} as const;

/** Insert a freshly-started run (status `running`). */
export async function startSelfqaRun(input: {
  workspaceId: string;
  suite: QaSuite;
  target: string;
  now?: Date;
}): Promise<SelfqaRunRecord> {
  const [row] = await db
    .insert(selfqaRuns)
    .values({
      workspaceId: input.workspaceId,
      suite: input.suite,
      target: input.target,
      status: "running",
      ...(input.now ? { startedAt: input.now } : {}),
    })
    .returning(COLS);
  return row as SelfqaRunRecord;
}

/** Finish a run with its summary counts. Passed iff no check failed. */
export async function finishSelfqaRun(input: {
  id: string;
  summary: QaRunSummary;
  now?: Date;
}): Promise<void> {
  await db
    .update(selfqaRuns)
    .set({
      status: input.summary.checksFailed === 0 ? "passed" : "failed",
      checksTotal: input.summary.checksTotal,
      checksFailed: input.summary.checksFailed,
      criticalCount: input.summary.criticalCount,
      finishedAt: input.now ?? new Date(),
    })
    .where(eq(selfqaRuns.id, input.id));
}

/** Recent runs for a workspace (newest first) — the #104 console read. */
export async function listSelfqaRuns(workspaceId: string, limit = 50): Promise<SelfqaRunRecord[]> {
  const rows = await db
    .select(COLS)
    .from(selfqaRuns)
    .where(eq(selfqaRuns.workspaceId, workspaceId))
    .orderBy(desc(selfqaRuns.startedAt))
    .limit(limit);
  return rows as SelfqaRunRecord[];
}
