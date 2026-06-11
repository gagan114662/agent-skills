import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import { gateEvidence, gateBoundaryChanges, approvalPolicies } from "../schema/index.js";
import type { Outcome } from "../../gate-pricing/pricing.js";

/**
 * Persistence for Evidence-Priced Autonomy (#119, ADR-0119). Records per-decision evidence and the
 * boundary-change audit, and reads the trailing window the pricer prices on. No gating logic lives
 * here — that is the pure `gate-pricing/` core; this is pure IO.
 */

// ---- evidence ---------------------------------------------------------------------------------

export interface GateEvidenceInput {
  workspaceId: string;
  actionType: string;
  outcome: Outcome;
  /** Levenshtein distance between the agent's draft and the human-edited version (only for `edited`). */
  editDistance?: number | null;
  /** decided_at − created_at, in milliseconds (clamped ≥ 0). */
  timeToDecisionMs: number;
  requestId?: string | null;
  decidedByMemberId?: string | null;
}

/** Append one decision-outcome evidence row. Append-only; never updated. */
export async function recordGateEvidence(input: GateEvidenceInput): Promise<void> {
  await db.insert(gateEvidence).values({
    workspaceId: input.workspaceId,
    actionType: input.actionType,
    outcome: input.outcome,
    editDistance: input.editDistance ?? null,
    timeToDecisionMs: Math.max(0, Math.trunc(input.timeToDecisionMs)),
    requestId: input.requestId ?? null,
    decidedByMemberId: input.decidedByMemberId ?? null,
  });
}

/**
 * The last `limit` decision outcomes for an action class, **newest-first** — the trailing window the
 * pricer measures. Returns the raw outcomes (the pure `summarizeWindow` does the math).
 */
export async function readEvidenceWindow(
  workspaceId: string,
  actionType: string,
  limit: number,
): Promise<Outcome[]> {
  const rows = await db
    .select({ outcome: gateEvidence.outcome })
    .from(gateEvidence)
    .where(and(eq(gateEvidence.workspaceId, workspaceId), eq(gateEvidence.actionType, actionType)))
    .orderBy(desc(gateEvidence.createdAt))
    .limit(limit);
  return rows.map((r) => r.outcome as Outcome);
}

/** Distinct action classes that have recorded evidence for the workspace — the pricer's work-list. */
export async function listEvidenceActionTypes(workspaceId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ actionType: gateEvidence.actionType })
    .from(gateEvidence)
    .where(eq(gateEvidence.workspaceId, workspaceId));
  return rows.map((r) => r.actionType);
}

// ---- boundary-change audit --------------------------------------------------------------------

export interface GateBoundaryChange {
  id: string;
  actionType: string;
  direction: "RELAX" | "RETIGHTEN";
  errorRate: number;
  windowSize: number;
  policyRuleId: string | null;
  reason: string;
  createdAt: Date;
}

const BOUNDARY_COLUMNS = {
  id: gateBoundaryChanges.id,
  actionType: gateBoundaryChanges.actionType,
  direction: gateBoundaryChanges.direction,
  errorRate: gateBoundaryChanges.errorRate,
  windowSize: gateBoundaryChanges.windowSize,
  policyRuleId: gateBoundaryChanges.policyRuleId,
  reason: gateBoundaryChanges.reason,
  createdAt: gateBoundaryChanges.createdAt,
} as const;

/** Append one boundary-change audit row (the #13-style audit of a human/AI-split move). */
export async function recordBoundaryChange(input: {
  workspaceId: string;
  actionType: string;
  direction: "RELAX" | "RETIGHTEN";
  errorRate: number;
  windowSize: number;
  policyRuleId: string | null;
  reason: string;
}): Promise<GateBoundaryChange> {
  const [row] = await db
    .insert(gateBoundaryChanges)
    .values({
      workspaceId: input.workspaceId,
      actionType: input.actionType,
      direction: input.direction,
      errorRate: input.errorRate,
      windowSize: input.windowSize,
      policyRuleId: input.policyRuleId,
      reason: input.reason,
    })
    .returning(BOUNDARY_COLUMNS);
  return row as GateBoundaryChange;
}

/** Recent boundary changes for the workspace, newest-first (the Console history). */
export async function listBoundaryChanges(
  workspaceId: string,
  limit = 50,
): Promise<GateBoundaryChange[]> {
  const rows = await db
    .select(BOUNDARY_COLUMNS)
    .from(gateBoundaryChanges)
    .where(eq(gateBoundaryChanges.workspaceId, workspaceId))
    .orderBy(desc(gateBoundaryChanges.createdAt))
    .limit(limit);
  return rows as GateBoundaryChange[];
}

export interface OwnedBoundary {
  actionType: string;
  /** The measured error rate that earned the current relaxed boundary. */
  errorRate: number;
  windowSize: number;
  /** When the boundary was last RELAXed (epoch ms). */
  sinceMs: number;
}

/**
 * The action classes agents currently **own** — a #95 auto-approve rule (`require_approval = false`)
 * that was *earned by evidence* (has a RELAX boundary-change). Each carries the latest RELAX's error
 * rate / window / timestamp. A manually-created auto-approve rule with no RELAX history is excluded
 * (it was not priced by evidence). Powers the Founder Console `autonomyBoundaries.owned` surface.
 */
export async function ownedBoundaries(workspaceId: string): Promise<OwnedBoundary[]> {
  const relaxedRules = await db
    .select({ actionType: approvalPolicies.actionType })
    .from(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.workspaceId, workspaceId),
        eq(approvalPolicies.requireApproval, false),
      ),
    );
  if (relaxedRules.length === 0) return [];
  const relaxedSet = new Set(relaxedRules.map((r) => r.actionType));

  // Newest-first RELAX changes; the first seen per action is its current earning evidence.
  const relaxChanges = await db
    .select(BOUNDARY_COLUMNS)
    .from(gateBoundaryChanges)
    .where(
      and(
        eq(gateBoundaryChanges.workspaceId, workspaceId),
        eq(gateBoundaryChanges.direction, sql`'RELAX'`),
      ),
    )
    .orderBy(desc(gateBoundaryChanges.createdAt));

  const owned: OwnedBoundary[] = [];
  const seen = new Set<string>();
  for (const c of relaxChanges as GateBoundaryChange[]) {
    if (!relaxedSet.has(c.actionType) || seen.has(c.actionType)) continue;
    seen.add(c.actionType);
    owned.push({
      actionType: c.actionType,
      errorRate: c.errorRate,
      windowSize: c.windowSize,
      sinceMs: c.createdAt.getTime(),
    });
  }
  return owned;
}
