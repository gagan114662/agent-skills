import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "../index.js";
import { factoryCandidates, factoryValidations, factoryVentures } from "../schema/index.js";
import type {
  CandidateRecord,
  CandidateSourceKind,
  CandidateStatus,
  EdgeClaim,
  EdgeStatus,
  FactoryVenture,
  ValidationRecord,
  ValidationReceipt,
  ValidationVerdict,
} from "../../venture-factory/types.js";

/**
 * Venture Factory repositories (#187, ADR-0187). Workspace-scoped throughout (the #3 IDOR discipline);
 * the pure decisions live in `venture-factory/*.ts` — this is persistence only. Integer columns are
 * rounded so an upstream float never violates the column type (the #107 repo discipline).
 */

const CANDIDATE_COLS = {
  id: factoryCandidates.id,
  workspaceId: factoryCandidates.workspaceId,
  source: factoryCandidates.source,
  thesis: factoryCandidates.thesis,
  proposedName: factoryCandidates.proposedName,
  painIntensity: factoryCandidates.painIntensity,
  competitionAbsence: factoryCandidates.competitionAbsence,
  observedAt: factoryCandidates.observedAt,
  citations: factoryCandidates.citations,
  score: factoryCandidates.score,
  edgeClaims: factoryCandidates.edgeClaims,
  edgeStatus: factoryCandidates.edgeStatus,
  status: factoryCandidates.status,
  createdByMemberId: factoryCandidates.createdByMemberId,
  createdAt: factoryCandidates.createdAt,
} as const;

export async function insertCandidate(input: {
  workspaceId: string;
  source: CandidateSourceKind;
  thesis: string;
  proposedName: string;
  painIntensity: number;
  competitionAbsence: number;
  observedAt: Date;
  citations: string[];
  score: number;
  edgeClaims: EdgeClaim[];
  createdByMemberId: string | null;
}): Promise<CandidateRecord> {
  const [row] = await db
    .insert(factoryCandidates)
    .values({
      workspaceId: input.workspaceId,
      source: input.source,
      thesis: input.thesis,
      proposedName: input.proposedName,
      painIntensity: Math.round(input.painIntensity),
      competitionAbsence: Math.round(input.competitionAbsence),
      observedAt: input.observedAt,
      citations: input.citations,
      score: Math.round(input.score),
      edgeClaims: input.edgeClaims,
      createdByMemberId: input.createdByMemberId,
    })
    .returning(CANDIDATE_COLS);
  return row as CandidateRecord;
}

export async function getCandidate(
  workspaceId: string,
  id: string,
): Promise<CandidateRecord | undefined> {
  const [row] = await db
    .select(CANDIDATE_COLS)
    .from(factoryCandidates)
    .where(and(eq(factoryCandidates.workspaceId, workspaceId), eq(factoryCandidates.id, id)))
    .limit(1);
  return row as CandidateRecord | undefined;
}

/** Candidates in a given status, highest-score first — the scanner/validation work-list. */
export async function listCandidatesByStatus(
  workspaceId: string,
  status: CandidateStatus,
  limit = 100,
): Promise<CandidateRecord[]> {
  const rows = await db
    .select(CANDIDATE_COLS)
    .from(factoryCandidates)
    .where(and(eq(factoryCandidates.workspaceId, workspaceId), eq(factoryCandidates.status, status)))
    .orderBy(desc(factoryCandidates.score), desc(factoryCandidates.createdAt))
    .limit(limit);
  return rows as CandidateRecord[];
}

/** Count candidates in a given status for watch-only console roll-ups. */
export async function countCandidatesByStatus(
  workspaceId: string,
  status: CandidateStatus,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(factoryCandidates)
    .where(and(eq(factoryCandidates.workspaceId, workspaceId), eq(factoryCandidates.status, status)));
  return row?.count ?? 0;
}

export async function setCandidate(
  workspaceId: string,
  id: string,
  patch: { status?: CandidateStatus; edgeStatus?: EdgeStatus | "unevaluated" },
): Promise<CandidateRecord | undefined> {
  const [row] = await db
    .update(factoryCandidates)
    .set({
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.edgeStatus !== undefined ? { edgeStatus: patch.edgeStatus } : {}),
    })
    .where(and(eq(factoryCandidates.workspaceId, workspaceId), eq(factoryCandidates.id, id)))
    .returning(CANDIDATE_COLS);
  return row as CandidateRecord | undefined;
}

const VALIDATION_COLS = {
  id: factoryValidations.id,
  workspaceId: factoryValidations.workspaceId,
  candidateId: factoryValidations.candidateId,
  budgetCapCents: factoryValidations.budgetCapCents,
  spentCents: factoryValidations.spentCents,
  signups: factoryValidations.signups,
  cacCents: factoryValidations.cacCents,
  score: factoryValidations.score,
  verdict: factoryValidations.verdict,
  status: factoryValidations.status,
  receipts: factoryValidations.receipts,
  createdAt: factoryValidations.createdAt,
  updatedAt: factoryValidations.updatedAt,
} as const;

/** Start a validation experiment for a candidate, idempotently (one per candidate — the UK). */
export async function ensureValidation(input: {
  workspaceId: string;
  candidateId: string;
  budgetCapCents: number;
}): Promise<ValidationRecord> {
  const [row] = await db
    .insert(factoryValidations)
    .values({
      workspaceId: input.workspaceId,
      candidateId: input.candidateId,
      budgetCapCents: Math.round(input.budgetCapCents),
    })
    .onConflictDoNothing({ target: [factoryValidations.workspaceId, factoryValidations.candidateId] })
    .returning(VALIDATION_COLS);
  if (row) return row as ValidationRecord;
  const existing = await getValidationByCandidate(input.workspaceId, input.candidateId);
  if (!existing) throw new Error(`validation upsert failed for candidate ${input.candidateId}`);
  return existing;
}

export async function getValidationByCandidate(
  workspaceId: string,
  candidateId: string,
): Promise<ValidationRecord | undefined> {
  const [row] = await db
    .select(VALIDATION_COLS)
    .from(factoryValidations)
    .where(
      and(
        eq(factoryValidations.workspaceId, workspaceId),
        eq(factoryValidations.candidateId, candidateId),
      ),
    )
    .limit(1);
  return row as ValidationRecord | undefined;
}

/** Apply the latest scorecard + receipts + verdict to an experiment (bumps `updated_at`). */
export async function updateValidation(
  workspaceId: string,
  id: string,
  patch: {
    spentCents?: number;
    signups?: number;
    cacCents?: number | null;
    score?: number;
    verdict?: ValidationVerdict | null;
    status?: "running" | "concluded";
    receipts?: ValidationReceipt[];
  },
): Promise<ValidationRecord | undefined> {
  const [row] = await db
    .update(factoryValidations)
    .set({
      ...(patch.spentCents !== undefined ? { spentCents: Math.round(patch.spentCents) } : {}),
      ...(patch.signups !== undefined ? { signups: Math.max(0, Math.trunc(patch.signups)) } : {}),
      ...(patch.cacCents !== undefined
        ? { cacCents: patch.cacCents === null ? null : Math.round(patch.cacCents) }
        : {}),
      ...(patch.score !== undefined ? { score: Math.round(patch.score) } : {}),
      ...(patch.verdict !== undefined ? { verdict: patch.verdict } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.receipts !== undefined ? { receipts: patch.receipts } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(factoryValidations.workspaceId, workspaceId), eq(factoryValidations.id, id)))
    .returning(VALIDATION_COLS);
  return row as ValidationRecord | undefined;
}

const VENTURE_COLS = {
  id: factoryVentures.id,
  workspaceId: factoryVentures.workspaceId,
  candidateId: factoryVentures.candidateId,
  ventureIdeaId: factoryVentures.ventureIdeaId,
  name: factoryVentures.name,
  status: factoryVentures.status,
  approvalRequestId: factoryVentures.approvalRequestId,
  createdAt: factoryVentures.createdAt,
  archivedAt: factoryVentures.archivedAt,
} as const;

/** Idempotently create a factory venture for a candidate (one per candidate — the UK). */
export async function ensureVenture(input: {
  workspaceId: string;
  candidateId: string;
  name: string;
  approvalRequestId: string | null;
}): Promise<FactoryVenture> {
  const [row] = await db
    .insert(factoryVentures)
    .values({
      workspaceId: input.workspaceId,
      candidateId: input.candidateId,
      name: input.name,
      approvalRequestId: input.approvalRequestId,
    })
    .onConflictDoNothing({ target: [factoryVentures.workspaceId, factoryVentures.candidateId] })
    .returning(VENTURE_COLS);
  if (row) return row as FactoryVenture;
  const [existing] = await db
    .select(VENTURE_COLS)
    .from(factoryVentures)
    .where(
      and(
        eq(factoryVentures.workspaceId, input.workspaceId),
        eq(factoryVentures.candidateId, input.candidateId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error(`venture upsert failed for candidate ${input.candidateId}`);
  return existing as FactoryVenture;
}

export async function getVentureByCandidate(
  workspaceId: string,
  candidateId: string,
): Promise<FactoryVenture | undefined> {
  const [row] = await db
    .select(VENTURE_COLS)
    .from(factoryVentures)
    .where(
      and(eq(factoryVentures.workspaceId, workspaceId), eq(factoryVentures.candidateId, candidateId)),
    )
    .limit(1);
  return row as FactoryVenture | undefined;
}

export async function setVenture(
  workspaceId: string,
  id: string,
  patch: {
    status?: "launching" | "launched" | "archived";
    ventureIdeaId?: string | null;
    archivedAt?: Date | null;
  },
): Promise<FactoryVenture | undefined> {
  const [row] = await db
    .update(factoryVentures)
    .set({
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.ventureIdeaId !== undefined ? { ventureIdeaId: patch.ventureIdeaId } : {}),
      ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
    })
    .where(and(eq(factoryVentures.workspaceId, workspaceId), eq(factoryVentures.id, id)))
    .returning(VENTURE_COLS);
  return row as FactoryVenture | undefined;
}

export async function listVentures(workspaceId: string): Promise<FactoryVenture[]> {
  const rows = await db
    .select(VENTURE_COLS)
    .from(factoryVentures)
    .where(eq(factoryVentures.workspaceId, workspaceId))
    .orderBy(desc(factoryVentures.createdAt))
    .limit(500);
  return rows as FactoryVenture[];
}

/** Count ventures not yet archived — the active-venture input to the scaling gate. */
export async function countActiveVentures(workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: factoryVentures.id })
    .from(factoryVentures)
    .where(and(eq(factoryVentures.workspaceId, workspaceId), ne(factoryVentures.status, "archived")));
  return rows.length;
}

/** Distinct workspaces with a `scanned` candidate — the scanner tick's work-list. */
export async function listScannedCandidateWorkspaces(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workspaceId: factoryCandidates.workspaceId })
    .from(factoryCandidates)
    .where(eq(factoryCandidates.status, "scanned"));
  return rows.map((r) => r.workspaceId);
}
