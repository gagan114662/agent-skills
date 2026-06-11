import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { evalRuns } from "../schema/index.js";
import type { EvalRunRecord } from "../../evals/types.js";

/**
 * Eval-run repository (#155, ADR-0155 §4). Workspace-scoped throughout (the #3 IDOR discipline). The pure
 * grading/regression logic lives in `evals/grade.ts` + `evals/regression.ts`; this is persistence only.
 * `pass_rate` is stored in basis points (0–10000) so the column is integer + exact; the boundary converts.
 */

const COLS = {
  id: evalRuns.id,
  workspaceId: evalRuns.workspaceId,
  agent: evalRuns.agent,
  suiteVersion: evalRuns.suiteVersion,
  gitSha: evalRuns.gitSha,
  modelId: evalRuns.modelId,
  total: evalRuns.total,
  passed: evalRuns.passed,
  failed: evalRuns.failed,
  passRate: evalRuns.passRate,
  tokens: evalRuns.tokens,
  regressed: evalRuns.regressed,
  createdAt: evalRuns.createdAt,
} as const;

type Row = {
  id: string;
  workspaceId: string;
  agent: string;
  suiteVersion: string;
  gitSha: string;
  modelId: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  tokens: number;
  regressed: boolean;
  createdAt: Date;
};

function toRecord(row: Row): EvalRunRecord {
  return { ...row, passRate: row.passRate / 10000 };
}

export async function insertEvalRun(input: {
  workspaceId: string;
  agent: string;
  suiteVersion: string;
  gitSha: string;
  modelId: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number; // 0–1
  tokens: number;
  regressed: boolean;
  createdAt?: Date;
}): Promise<EvalRunRecord> {
  const [row] = await db
    .insert(evalRuns)
    .values({
      workspaceId: input.workspaceId,
      agent: input.agent,
      suiteVersion: input.suiteVersion,
      gitSha: input.gitSha,
      modelId: input.modelId,
      total: input.total,
      passed: input.passed,
      failed: input.failed,
      passRate: Math.round(Math.max(0, Math.min(1, input.passRate)) * 10000),
      tokens: input.tokens,
      regressed: input.regressed,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning(COLS);
  return toRecord(row as Row);
}

/** List runs for a workspace (newest first), optionally filtered to one agent. */
export async function listEvalRuns(
  workspaceId: string,
  agent?: string,
  limit = 50,
): Promise<EvalRunRecord[]> {
  const where = agent
    ? and(eq(evalRuns.workspaceId, workspaceId), eq(evalRuns.agent, agent))
    : eq(evalRuns.workspaceId, workspaceId);
  const rows = await db.select(COLS).from(evalRuns).where(where).orderBy(desc(evalRuns.createdAt)).limit(limit);
  return rows.map((r) => toRecord(r as Row));
}
