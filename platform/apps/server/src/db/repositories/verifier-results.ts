import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { verifierResults } from "../schema/index.js";
import type { VerifierResultStore } from "../../verifiers/engine.js";
import type { VerifierKind, VerifierResultRecord, VerifierStatus } from "../../verifiers/types.js";

/**
 * Persistence for Outcome Verifiers (#106, ADR-0106). Implements the {@link VerifierResultStore} seam
 * over the append-only `verifier_results` table, plus the read API #96 / #117 / #119 consume
 * (`latestResult` / `listVerifierResults`). No verdict logic lives here — that is the pure `verifiers/`
 * core; this is pure IO.
 */

const COLUMNS = {
  id: verifierResults.id,
  workspaceId: verifierResults.workspaceId,
  kind: verifierResults.kind,
  claimRef: verifierResults.claimRef,
  status: verifierResults.status,
  measuredValue: verifierResults.measuredValue,
  threshold: verifierResults.threshold,
  detail: verifierResults.detail,
  escalationRequestId: verifierResults.escalationRequestId,
  source: verifierResults.source,
  createdAt: verifierResults.createdAt,
} as const;

/** Append one verification verdict. Append-only; never updated. */
export async function recordVerifierResult(input: {
  workspaceId: string;
  kind: VerifierKind;
  claimRef: string;
  status: VerifierStatus;
  measuredValue: number;
  threshold: number;
  detail: string;
  escalationRequestId?: string | null;
  source?: string | null;
  now: Date;
}): Promise<VerifierResultRecord> {
  const [row] = await db
    .insert(verifierResults)
    .values({
      workspaceId: input.workspaceId,
      kind: input.kind,
      claimRef: input.claimRef,
      status: input.status,
      measuredValue: input.measuredValue,
      threshold: input.threshold,
      detail: input.detail,
      escalationRequestId: input.escalationRequestId ?? null,
      source: input.source ?? null,
      createdAt: input.now,
    })
    .returning(COLUMNS);
  return row as VerifierResultRecord;
}

/**
 * The latest verdict for a (kind, claim) — the read the venture scorecard (#96) gates "done" on and the
 * flywheel (#117) reads for `fix_held`. Null when the claim has never been verified.
 */
export async function latestResult(
  workspaceId: string,
  kind: VerifierKind,
  claimRef: string,
): Promise<VerifierResultRecord | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(verifierResults)
    .where(
      and(
        eq(verifierResults.workspaceId, workspaceId),
        eq(verifierResults.kind, kind),
        eq(verifierResults.claimRef, claimRef),
      ),
    )
    .orderBy(desc(verifierResults.createdAt))
    .limit(1);
  return (row as VerifierResultRecord | undefined) ?? null;
}

/** Recent verdicts for a workspace (most-recent first) — the read surface + the #119 trailing window. */
export async function listVerifierResults(
  workspaceId: string,
  opts: { kind?: VerifierKind; status?: VerifierStatus; limit?: number } = {},
): Promise<VerifierResultRecord[]> {
  const filters = [eq(verifierResults.workspaceId, workspaceId)];
  if (opts.kind) filters.push(eq(verifierResults.kind, opts.kind));
  if (opts.status) filters.push(eq(verifierResults.status, opts.status));
  const rows = await db
    .select(COLUMNS)
    .from(verifierResults)
    .where(and(...filters))
    .orderBy(desc(verifierResults.createdAt))
    .limit(Math.min(200, Math.max(1, opts.limit ?? 50)));
  return rows as VerifierResultRecord[];
}

/** The full store, satisfying the runner's {@link VerifierResultStore} seam. */
export const verifierResultStore: VerifierResultStore = {
  record: recordVerifierResult,
};
