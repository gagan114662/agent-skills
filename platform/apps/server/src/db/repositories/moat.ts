import { and, asc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { moatLedger } from "../schema/index.js";
import type { MoatAccrual, MoatLedgerEntry } from "../../moat/types.js";

/**
 * Moat-accrual ledger repository (#103, ADR-0103). Workspace-scoped throughout (the #3 IDOR
 * discipline); pure scoring/stagnation logic lives in `../../moat/score.ts` — this is persistence only.
 */

const LEDGER_COLS = {
  id: moatLedger.id,
  workspaceId: moatLedger.workspaceId,
  ventureIdeaId: moatLedger.ventureIdeaId,
  dimension: moatLedger.dimension,
  magnitude: moatLedger.magnitude,
  unit: moatLedger.unit,
  description: moatLedger.description,
  provenance: moatLedger.provenance,
  sourceRef: moatLedger.sourceRef,
  createdByMemberId: moatLedger.createdByMemberId,
  createdAt: moatLedger.createdAt,
} as const;

export async function recordAccrual(
  input: MoatAccrual & {
    workspaceId: string;
    ventureIdeaId: string;
    createdByMemberId: string | null;
    createdAt?: Date;
  },
): Promise<MoatLedgerEntry> {
  const [row] = await db
    .insert(moatLedger)
    .values({
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId,
      dimension: input.dimension,
      magnitude: Math.max(0, Math.round(input.magnitude)),
      unit: input.unit,
      description: input.description,
      provenance: input.provenance,
      sourceRef: input.sourceRef,
      createdByMemberId: input.createdByMemberId,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning(LEDGER_COLS);
  return row as MoatLedgerEntry;
}

/** Every accrual for a venture, workspace-scoped, oldest-first. */
export async function listAccruals(
  workspaceId: string,
  ventureIdeaId: string,
): Promise<MoatLedgerEntry[]> {
  const rows = await db
    .select(LEDGER_COLS)
    .from(moatLedger)
    .where(and(eq(moatLedger.workspaceId, workspaceId), eq(moatLedger.ventureIdeaId, ventureIdeaId)))
    .orderBy(asc(moatLedger.createdAt));
  return rows as MoatLedgerEntry[];
}
