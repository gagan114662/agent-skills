import { and, asc, desc, eq, gt } from "drizzle-orm";
import { db } from "../index.js";
import {
  ventureIdeas,
  ventureScorecards,
  ventureIterations,
  ventureEvaluations,
} from "../schema/index.js";
import type { PersonaScorecard } from "../../venture/rubric.js";
import type {
  Evidence,
  GapList,
  IdeaInput,
  IdeaStatus,
  IterationLogEntry,
  Scorecard,
  Verdict,
  VentureEvaluation,
  VentureIdea,
} from "../../venture/types.js";

/**
 * Venture Loop repository (#96, ADR-0049). Workspace-scoped throughout (the #3 IDOR discipline);
 * pure decision/guard/rubric logic lives in `../../venture/*` — this is persistence only.
 */

const IDEA_COLS = {
  id: ventureIdeas.id,
  workspaceId: ventureIdeas.workspaceId,
  problem: ventureIdeas.problem,
  targetUser: ventureIdeas.targetUser,
  insight: ventureIdeas.insight,
  wedge: ventureIdeas.wedge,
  marketPath: ventureIdeas.marketPath,
  status: ventureIdeas.status,
  epicTaskId: ventureIdeas.epicTaskId,
  createdByMemberId: ventureIdeas.createdByMemberId,
  createdAt: ventureIdeas.createdAt,
} as const;

export async function createIdea(
  input: IdeaInput & { workspaceId: string; createdByMemberId: string | null },
): Promise<VentureIdea> {
  const [row] = await db
    .insert(ventureIdeas)
    .values({
      workspaceId: input.workspaceId,
      problem: input.problem,
      targetUser: input.targetUser,
      insight: input.insight,
      wedge: input.wedge,
      marketPath: input.marketPath,
      createdByMemberId: input.createdByMemberId,
    })
    .returning(IDEA_COLS);
  return row as VentureIdea;
}

export async function getIdea(
  workspaceId: string,
  ideaId: string,
): Promise<VentureIdea | undefined> {
  const [row] = await db
    .select(IDEA_COLS)
    .from(ventureIdeas)
    .where(and(eq(ventureIdeas.id, ideaId), eq(ventureIdeas.workspaceId, workspaceId)))
    .limit(1);
  return row as VentureIdea | undefined;
}

export async function updateIdeaStatus(
  workspaceId: string,
  ideaId: string,
  status: IdeaStatus,
): Promise<void> {
  await db
    .update(ventureIdeas)
    .set({ status })
    .where(and(eq(ventureIdeas.id, ideaId), eq(ventureIdeas.workspaceId, workspaceId)));
}

export async function setIdeaEpic(
  workspaceId: string,
  ideaId: string,
  epicTaskId: string,
): Promise<void> {
  await db
    .update(ventureIdeas)
    .set({ epicTaskId })
    .where(and(eq(ventureIdeas.id, ideaId), eq(ventureIdeas.workspaceId, workspaceId)));
}

const SCORECARD_COLS = {
  id: ventureScorecards.id,
  workspaceId: ventureScorecards.workspaceId,
  ideaId: ventureScorecards.ideaId,
  iteration: ventureScorecards.iteration,
  score: ventureScorecards.score,
  verdict: ventureScorecards.verdict,
  advocate: ventureScorecards.advocate,
  reviewer: ventureScorecards.reviewer,
  reasoning: ventureScorecards.reasoning,
  funded: ventureScorecards.funded,
  createdAt: ventureScorecards.createdAt,
  expiresAt: ventureScorecards.expiresAt,
} as const;

function toScorecard(row: Record<string, unknown>): Scorecard {
  return {
    ...(row as Omit<Scorecard, "advocate" | "reviewer">),
    advocate: row.advocate as PersonaScorecard,
    reviewer: row.reviewer as PersonaScorecard,
  } as Scorecard;
}

export async function insertScorecard(input: {
  workspaceId: string;
  ideaId: string;
  iteration: number;
  score: number;
  advocate: PersonaScorecard;
  reviewer: PersonaScorecard;
  reasoning: string;
  expiresAt: Date;
}): Promise<Scorecard> {
  const [row] = await db
    .insert(ventureScorecards)
    .values({
      workspaceId: input.workspaceId,
      ideaId: input.ideaId,
      iteration: input.iteration,
      score: Math.round(input.score),
      advocate: input.advocate,
      reviewer: input.reviewer,
      reasoning: input.reasoning,
      expiresAt: input.expiresAt,
    })
    .returning(SCORECARD_COLS);
  return toScorecard(row as Record<string, unknown>);
}

export async function latestScorecard(
  workspaceId: string,
  ideaId: string,
): Promise<Scorecard | undefined> {
  const [row] = await db
    .select(SCORECARD_COLS)
    .from(ventureScorecards)
    .where(and(eq(ventureScorecards.workspaceId, workspaceId), eq(ventureScorecards.ideaId, ideaId)))
    .orderBy(desc(ventureScorecards.iteration), desc(ventureScorecards.createdAt))
    .limit(1);
  return row ? toScorecard(row as Record<string, unknown>) : undefined;
}

export async function setScorecardVerdict(
  workspaceId: string,
  scorecardId: string,
  verdict: Verdict,
  funded: boolean,
): Promise<void> {
  await db
    .update(ventureScorecards)
    .set({ verdict, funded })
    .where(and(eq(ventureScorecards.id, scorecardId), eq(ventureScorecards.workspaceId, workspaceId)));
}

/** True iff the workspace holds a passing (FUND + funded) scorecard that has not yet expired. */
export async function hasPassingUnexpiredScorecard(
  workspaceId: string,
  now: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ id: ventureScorecards.id })
    .from(ventureScorecards)
    .where(
      and(
        eq(ventureScorecards.workspaceId, workspaceId),
        eq(ventureScorecards.funded, true),
        eq(ventureScorecards.verdict, "FUND"),
        gt(ventureScorecards.expiresAt, now),
      ),
    )
    .limit(1);
  return row !== undefined;
}

const ITERATION_COLS = {
  id: ventureIterations.id,
  workspaceId: ventureIterations.workspaceId,
  ideaId: ventureIterations.ideaId,
  iteration: ventureIterations.iteration,
  score: ventureIterations.score,
  verdict: ventureIterations.verdict,
  gapList: ventureIterations.gapList,
  angles: ventureIterations.angles,
  evidence: ventureIterations.evidence,
  workingMemorySummary: ventureIterations.workingMemorySummary,
  createdAt: ventureIterations.createdAt,
} as const;

export async function insertIteration(input: {
  workspaceId: string;
  ideaId: string;
  iteration: number;
  score: number;
  verdict: Verdict;
  gapList: GapList;
  angles: string[];
  evidence: Evidence[];
  workingMemorySummary: string;
}): Promise<IterationLogEntry> {
  const [row] = await db
    .insert(ventureIterations)
    .values({
      workspaceId: input.workspaceId,
      ideaId: input.ideaId,
      iteration: input.iteration,
      score: Math.round(input.score),
      verdict: input.verdict,
      gapList: input.gapList,
      angles: input.angles,
      evidence: input.evidence,
      workingMemorySummary: input.workingMemorySummary,
    })
    .returning(ITERATION_COLS);
  return row as unknown as IterationLogEntry;
}

export async function listIterations(
  workspaceId: string,
  ideaId: string,
): Promise<IterationLogEntry[]> {
  const rows = await db
    .select(ITERATION_COLS)
    .from(ventureIterations)
    .where(and(eq(ventureIterations.workspaceId, workspaceId), eq(ventureIterations.ideaId, ideaId)))
    .orderBy(asc(ventureIterations.iteration), asc(ventureIterations.createdAt));
  return rows as unknown as IterationLogEntry[];
}

// ---- evaluations (durable loop state) ---------------------------------------

const EVALUATION_COLS = {
  id: ventureEvaluations.id,
  workspaceId: ventureEvaluations.workspaceId,
  ideaId: ventureEvaluations.ideaId,
  status: ventureEvaluations.status,
  terminalVerdict: ventureEvaluations.terminalVerdict,
  currentIteration: ventureEvaluations.currentIteration,
  failedAngles: ventureEvaluations.failedAngles,
  lastScore: ventureEvaluations.lastScore,
  costCents: ventureEvaluations.costCents,
  createdAt: ventureEvaluations.createdAt,
  updatedAt: ventureEvaluations.updatedAt,
} as const;

/** Get the idea's evaluation, creating a fresh `active` one if none exists (idempotent). */
export async function getOrCreateEvaluation(
  workspaceId: string,
  ideaId: string,
): Promise<VentureEvaluation> {
  await db
    .insert(ventureEvaluations)
    .values({ workspaceId, ideaId })
    .onConflictDoNothing({ target: ventureEvaluations.ideaId });
  const [row] = await db
    .select(EVALUATION_COLS)
    .from(ventureEvaluations)
    .where(and(eq(ventureEvaluations.ideaId, ideaId), eq(ventureEvaluations.workspaceId, workspaceId)))
    .limit(1);
  return row as VentureEvaluation;
}

export async function getEvaluation(
  workspaceId: string,
  ideaId: string,
): Promise<VentureEvaluation | undefined> {
  const [row] = await db
    .select(EVALUATION_COLS)
    .from(ventureEvaluations)
    .where(and(eq(ventureEvaluations.ideaId, ideaId), eq(ventureEvaluations.workspaceId, workspaceId)))
    .limit(1);
  return row as VentureEvaluation | undefined;
}

/** Patch the durable loop cursor (iteration / failed angles / score / cost / terminal verdict). */
export async function updateEvaluation(
  workspaceId: string,
  id: string,
  patch: {
    status?: "active" | "terminal";
    terminalVerdict?: Verdict | null;
    currentIteration?: number;
    failedAngles?: string[];
    lastScore?: number | null;
    costCents?: number;
  },
): Promise<void> {
  await db
    .update(ventureEvaluations)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(ventureEvaluations.id, id), eq(ventureEvaluations.workspaceId, workspaceId)));
}

/** The tick's per-workspace work-list: every still-`active` evaluation, oldest first. */
export async function listActiveEvaluations(workspaceId: string): Promise<VentureEvaluation[]> {
  const rows = await db
    .select(EVALUATION_COLS)
    .from(ventureEvaluations)
    .where(
      and(eq(ventureEvaluations.workspaceId, workspaceId), eq(ventureEvaluations.status, "active")),
    )
    .orderBy(asc(ventureEvaluations.createdAt));
  return rows as VentureEvaluation[];
}

/**
 * Every evaluation for a workspace, any status, newest-first — the #104 Founder Console pipeline
 * roll-up (active vs FUND/KILL/ESCALATE). Workspace-scoped (the #3 IDOR discipline); read-only.
 */
export async function listEvaluations(workspaceId: string): Promise<VentureEvaluation[]> {
  const rows = await db
    .select(EVALUATION_COLS)
    .from(ventureEvaluations)
    .where(eq(ventureEvaluations.workspaceId, workspaceId))
    .orderBy(desc(ventureEvaluations.createdAt));
  return rows as VentureEvaluation[];
}

/** Distinct workspaces with an `active` evaluation — the scheduled timer's work-list. */
export async function listActiveEvaluationWorkspaces(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workspaceId: ventureEvaluations.workspaceId })
    .from(ventureEvaluations)
    .where(eq(ventureEvaluations.status, "active"));
  return rows.map((r) => r.workspaceId);
}
