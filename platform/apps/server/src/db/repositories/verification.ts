import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import { verificationCriteria, verificationVerdicts } from "../schema/index.js";
import type { DefinitionStore, VerdictStore } from "../../verification/engine.js";
import type {
  CheckResult,
  DefinitionOfDoneRecord,
  DeliverableKind,
  ReversibilityClass,
  SuccessCriterion,
  VerificationVerdictRecord,
} from "../../verification/types.js";

/**
 * Persistence for the Deliverable Verification Layer (#191, ADR-0191). Implements the engine's
 * {@link DefinitionStore} / {@link VerdictStore} seams over the two append-only tables, plus the
 * read API the console / proof surface consumes. No verdict logic lives here — that is the pure
 * `verification/` core; this is pure IO.
 */

const CRITERIA_COLUMNS = {
  id: verificationCriteria.id,
  workspaceId: verificationCriteria.workspaceId,
  deliverableRef: verificationCriteria.deliverableRef,
  deliverableKind: verificationCriteria.deliverableKind,
  reversibility: verificationCriteria.reversibility,
  criteria: verificationCriteria.criteria,
  briefDigest: verificationCriteria.briefDigest,
  createdAt: verificationCriteria.createdAt,
} as const;

const VERDICT_COLUMNS = {
  id: verificationVerdicts.id,
  workspaceId: verificationVerdicts.workspaceId,
  deliverableRef: verificationVerdicts.deliverableRef,
  deliverableKind: verificationVerdicts.deliverableKind,
  status: verificationVerdicts.status,
  passed: verificationVerdicts.passed,
  confidence: verificationVerdicts.confidence,
  reversibility: verificationVerdicts.reversibility,
  independenceOk: verificationVerdicts.independenceOk,
  productionGrounded: verificationVerdicts.productionGrounded,
  retryCount: verificationVerdicts.retryCount,
  checks: verificationVerdicts.checks,
  workerMemberId: verificationVerdicts.workerMemberId,
  graderMemberId: verificationVerdicts.graderMemberId,
  approvalRequestId: verificationVerdicts.approvalRequestId,
  reason: verificationVerdicts.reason,
  createdAt: verificationVerdicts.createdAt,
} as const;

function toCriteriaRecord(row: Record<string, unknown>): DefinitionOfDoneRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    deliverableRef: row.deliverableRef as string,
    deliverableKind: row.deliverableKind as DeliverableKind,
    reversibility: row.reversibility as ReversibilityClass,
    criteria: row.criteria as SuccessCriterion[],
    briefDigest: row.briefDigest as string,
    createdAt: row.createdAt as Date,
  };
}

function toVerdictRecord(row: Record<string, unknown>): VerificationVerdictRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    deliverableRef: row.deliverableRef as string,
    deliverableKind: row.deliverableKind as DeliverableKind,
    status: row.status as VerificationVerdictRecord["status"],
    passed: row.passed as boolean,
    confidence: row.confidence as number,
    reversibility: row.reversibility as ReversibilityClass,
    independenceOk: row.independenceOk as boolean,
    productionGrounded: row.productionGrounded as boolean,
    retryCount: row.retryCount as number,
    checks: row.checks as CheckResult[],
    workerMemberId: (row.workerMemberId as string | null) ?? null,
    graderMemberId: (row.graderMemberId as string | null) ?? null,
    approvalRequestId: (row.approvalRequestId as string | null) ?? null,
    reason: row.reason as string,
    createdAt: row.createdAt as Date,
  };
}

// ---- definition of done -----------------------------------------------------------------------

export async function recordDefinition(input: {
  workspaceId: string;
  deliverableRef: string;
  deliverableKind: DeliverableKind;
  reversibility: ReversibilityClass;
  criteria: SuccessCriterion[];
  briefDigest: string;
  now: Date;
}): Promise<DefinitionOfDoneRecord> {
  const [row] = await db
    .insert(verificationCriteria)
    .values({
      workspaceId: input.workspaceId,
      deliverableRef: input.deliverableRef,
      deliverableKind: input.deliverableKind,
      reversibility: input.reversibility,
      criteria: input.criteria,
      briefDigest: input.briefDigest,
      createdAt: input.now,
    })
    .returning(CRITERIA_COLUMNS);
  return toCriteriaRecord(row as Record<string, unknown>);
}

export async function latestDefinition(
  workspaceId: string,
  deliverableRef: string,
): Promise<DefinitionOfDoneRecord | null> {
  const [row] = await db
    .select(CRITERIA_COLUMNS)
    .from(verificationCriteria)
    .where(
      and(
        eq(verificationCriteria.workspaceId, workspaceId),
        eq(verificationCriteria.deliverableRef, deliverableRef),
      ),
    )
    .orderBy(desc(verificationCriteria.createdAt))
    .limit(1);
  return row ? toCriteriaRecord(row as Record<string, unknown>) : null;
}

// ---- verdicts ---------------------------------------------------------------------------------

export async function recordVerdict(input: {
  workspaceId: string;
  deliverableRef: string;
  deliverableKind: DeliverableKind;
  status: VerificationVerdictRecord["status"];
  passed: boolean;
  confidence: number;
  reversibility: ReversibilityClass;
  independenceOk: boolean;
  productionGrounded: boolean;
  retryCount: number;
  checks: CheckResult[];
  workerMemberId: string | null;
  graderMemberId: string | null;
  approvalRequestId: string | null;
  reason: string;
  now: Date;
}): Promise<VerificationVerdictRecord> {
  const [row] = await db
    .insert(verificationVerdicts)
    .values({
      workspaceId: input.workspaceId,
      deliverableRef: input.deliverableRef,
      deliverableKind: input.deliverableKind,
      status: input.status,
      passed: input.passed,
      confidence: input.confidence,
      reversibility: input.reversibility,
      independenceOk: input.independenceOk,
      productionGrounded: input.productionGrounded,
      retryCount: input.retryCount,
      checks: input.checks,
      workerMemberId: input.workerMemberId,
      graderMemberId: input.graderMemberId,
      approvalRequestId: input.approvalRequestId,
      reason: input.reason,
      createdAt: input.now,
    })
    .returning(VERDICT_COLUMNS);
  return toVerdictRecord(row as Record<string, unknown>);
}

/** Count how many times this deliverable was returned to the worker (the fail→fix counter). */
export async function countReturns(workspaceId: string, deliverableRef: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(verificationVerdicts)
    .where(
      and(
        eq(verificationVerdicts.workspaceId, workspaceId),
        eq(verificationVerdicts.deliverableRef, deliverableRef),
        eq(verificationVerdicts.status, "return_to_worker"),
      ),
    );
  return row?.n ?? 0;
}

/** Recent verdicts for a workspace (most-recent first) — the read surface / proof console. */
export async function listVerdicts(
  workspaceId: string,
  opts: { deliverableRef?: string; status?: VerificationVerdictRecord["status"]; limit?: number } = {},
): Promise<VerificationVerdictRecord[]> {
  const filters = [eq(verificationVerdicts.workspaceId, workspaceId)];
  if (opts.deliverableRef) filters.push(eq(verificationVerdicts.deliverableRef, opts.deliverableRef));
  if (opts.status) filters.push(eq(verificationVerdicts.status, opts.status));
  const rows = await db
    .select(VERDICT_COLUMNS)
    .from(verificationVerdicts)
    .where(and(...filters))
    .orderBy(desc(verificationVerdicts.createdAt))
    .limit(Math.min(200, Math.max(1, opts.limit ?? 50)));
  return rows.map((r) => toVerdictRecord(r as Record<string, unknown>));
}

/** The definition store, satisfying the engine's {@link DefinitionStore} seam. */
export const definitionStore: DefinitionStore = {
  record: recordDefinition,
  latest: latestDefinition,
};

/** The verdict store, satisfying the engine's {@link VerdictStore} seam. */
export const verdictStore: VerdictStore = {
  record: recordVerdict,
  countReturns,
};
