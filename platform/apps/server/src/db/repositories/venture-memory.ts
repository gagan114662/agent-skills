import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../index.js";
import { memories, ventureOkrs, venturePlans, venturePlaybooks } from "../schema/index.js";
import type { RawVentureNode } from "../../venture-memory/memory.js";
import type {
  KeyResult,
  OkrRecord,
  OkrStatus,
  PlanItem,
  PlanRecord,
  PlanStatus,
  GoNoGo,
  PlaybookProvenance,
  PlaybookRecord,
} from "../../venture-memory/types.js";

/**
 * Venture Memory & Planning repository (#197, ADR-0197). Workspace-scoped throughout (the #3 IDOR
 * discipline). Venture MEMORY rows live in the #15 `memories` table (see `venture-memory/memory.ts`);
 * this persists the OKRs, the weekly plans, and the cross-venture playbooks. Pure logic lives in
 * `../../venture-memory/*` — this is persistence only.
 */

// ---- venture memory nodes (the #15 `memories` table, venture-tagged) ---------------------------

/**
 * The venture's memory nodes (a #15 `memories` read projecting `created_at` + the stale flag, which the
 * shared `NODE_COLS` omits — hygiene/staleness needs the timestamp). Workspace-scoped; filtered to the
 * `venture:<ideaId>` entity. Superseded (#16) nodes are excluded unless `includeStale`. Newest first.
 */
export async function listVentureMemoryNodes(
  workspaceId: string,
  entity: string,
  includeStale = false,
): Promise<RawVentureNode[]> {
  const conds = [
    eq(memories.workspaceId, workspaceId),
    eq(memories.type, "venture_memory"),
    eq(memories.entity, entity),
  ];
  if (!includeStale) conds.push(isNull(memories.supersededByMemoryId));
  const rows = await db
    .select({
      id: memories.id,
      content: memories.content,
      entity: memories.entity,
      createdAt: memories.createdAt,
      supersededByMemoryId: memories.supersededByMemoryId,
    })
    .from(memories)
    .where(and(...conds))
    .orderBy(desc(memories.createdAt))
    .limit(500);
  return rows.map((r) => ({
    id: r.id,
    content: r.content as RawVentureNode["content"],
    entity: r.entity,
    createdAtMs: r.createdAt.getTime(),
    stale: r.supersededByMemoryId !== null,
  }));
}

// ---- OKRs --------------------------------------------------------------------------------------

const OKR_COLS = {
  id: ventureOkrs.id,
  workspaceId: ventureOkrs.workspaceId,
  ideaId: ventureOkrs.ideaId,
  objective: ventureOkrs.objective,
  keyResults: ventureOkrs.keyResults,
  status: ventureOkrs.status,
  periodKey: ventureOkrs.periodKey,
  createdAt: ventureOkrs.createdAt,
  updatedAt: ventureOkrs.updatedAt,
} as const;

export async function insertOkr(input: {
  workspaceId: string;
  ideaId: string;
  objective: string;
  keyResults: KeyResult[];
  periodKey?: string;
}): Promise<OkrRecord> {
  const [row] = await db
    .insert(ventureOkrs)
    .values({
      workspaceId: input.workspaceId,
      ideaId: input.ideaId,
      objective: input.objective,
      keyResults: input.keyResults,
      periodKey: input.periodKey ?? "",
    })
    .returning(OKR_COLS);
  return row as OkrRecord;
}

/** Every OKR for a venture (newest first), workspace-scoped. */
export async function listOkrsForVenture(workspaceId: string, ideaId: string): Promise<OkrRecord[]> {
  const rows = await db
    .select(OKR_COLS)
    .from(ventureOkrs)
    .where(and(eq(ventureOkrs.workspaceId, workspaceId), eq(ventureOkrs.ideaId, ideaId)))
    .orderBy(desc(ventureOkrs.createdAt))
    .limit(50);
  return rows as OkrRecord[];
}

/** Every OKR in a workspace (newest first). */
export async function listOkrs(workspaceId: string): Promise<OkrRecord[]> {
  const rows = await db
    .select(OKR_COLS)
    .from(ventureOkrs)
    .where(eq(ventureOkrs.workspaceId, workspaceId))
    .orderBy(desc(ventureOkrs.createdAt))
    .limit(200);
  return rows as OkrRecord[];
}

/** Update an OKR's key-result measurements and/or status (workspace-scoped). Bumps `updated_at`. */
export async function updateOkr(
  workspaceId: string,
  id: string,
  patch: { keyResults?: KeyResult[]; status?: OkrStatus; objective?: string },
  now: Date,
): Promise<OkrRecord | undefined> {
  const [row] = await db
    .update(ventureOkrs)
    .set({
      ...(patch.keyResults ? { keyResults: patch.keyResults } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.objective ? { objective: patch.objective } : {}),
      updatedAt: now,
    })
    .where(and(eq(ventureOkrs.workspaceId, workspaceId), eq(ventureOkrs.id, id)))
    .returning(OKR_COLS);
  return row as OkrRecord | undefined;
}

// ---- weekly plans ------------------------------------------------------------------------------

const PLAN_COLS = {
  id: venturePlans.id,
  workspaceId: venturePlans.workspaceId,
  ideaId: venturePlans.ideaId,
  weekKey: venturePlans.weekKey,
  status: venturePlans.status,
  goNoGo: venturePlans.goNoGo,
  rationale: venturePlans.rationale,
  premortemCited: venturePlans.premortemCited,
  items: venturePlans.items,
  approvalRequestId: venturePlans.approvalRequestId,
  createdAt: venturePlans.createdAt,
  updatedAt: venturePlans.updatedAt,
} as const;

/**
 * Insert a drafted weekly plan, or return the existing one for the same (workspace, idea, week) — the
 * idempotency watermark (`venture_plans_week_uk`), so a repeat tick never drafts a duplicate plan.
 */
export async function upsertPlan(input: {
  workspaceId: string;
  ideaId: string;
  weekKey: string;
  goNoGo: GoNoGo;
  rationale: string;
  premortemCited: boolean;
  items: PlanItem[];
}): Promise<{ plan: PlanRecord; created: boolean }> {
  const inserted = await db
    .insert(venturePlans)
    .values({
      workspaceId: input.workspaceId,
      ideaId: input.ideaId,
      weekKey: input.weekKey,
      goNoGo: input.goNoGo,
      rationale: input.rationale,
      premortemCited: input.premortemCited,
      items: input.items,
    })
    .onConflictDoNothing({
      target: [venturePlans.workspaceId, venturePlans.ideaId, venturePlans.weekKey],
    })
    .returning(PLAN_COLS);
  if (inserted[0]) return { plan: inserted[0] as PlanRecord, created: true };

  const [existing] = await db
    .select(PLAN_COLS)
    .from(venturePlans)
    .where(
      and(
        eq(venturePlans.workspaceId, input.workspaceId),
        eq(venturePlans.ideaId, input.ideaId),
        eq(venturePlans.weekKey, input.weekKey),
      ),
    )
    .limit(1);
  return { plan: existing as PlanRecord, created: false };
}

export async function getPlan(workspaceId: string, id: string): Promise<PlanRecord | undefined> {
  const [row] = await db
    .select(PLAN_COLS)
    .from(venturePlans)
    .where(and(eq(venturePlans.workspaceId, workspaceId), eq(venturePlans.id, id)))
    .limit(1);
  return row as PlanRecord | undefined;
}

/** Every plan in a workspace (newest first), optionally narrowed to a set of statuses. */
export async function listPlans(
  workspaceId: string,
  statuses?: readonly PlanStatus[],
): Promise<PlanRecord[]> {
  const where =
    statuses && statuses.length > 0
      ? and(eq(venturePlans.workspaceId, workspaceId), inArray(venturePlans.status, [...statuses]))
      : eq(venturePlans.workspaceId, workspaceId);
  const rows = await db
    .select(PLAN_COLS)
    .from(venturePlans)
    .where(where)
    .orderBy(desc(venturePlans.createdAt))
    .limit(200);
  return rows as PlanRecord[];
}

/** Patch a plan's lifecycle/linkage fields (workspace-scoped). Bumps `updated_at`. */
export async function updatePlan(
  workspaceId: string,
  id: string,
  patch: { status?: PlanStatus; approvalRequestId?: string },
  now: Date,
): Promise<PlanRecord | undefined> {
  const [row] = await db
    .update(venturePlans)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.approvalRequestId ? { approvalRequestId: patch.approvalRequestId } : {}),
      updatedAt: now,
    })
    .where(and(eq(venturePlans.workspaceId, workspaceId), eq(venturePlans.id, id)))
    .returning(PLAN_COLS);
  return row as PlanRecord | undefined;
}

// ---- playbooks ---------------------------------------------------------------------------------

const PLAYBOOK_COLS = {
  id: venturePlaybooks.id,
  workspaceId: venturePlaybooks.workspaceId,
  category: venturePlaybooks.category,
  pattern: venturePlaybooks.pattern,
  provenance: venturePlaybooks.provenance,
  dedupeKey: venturePlaybooks.dedupeKey,
  createdAt: venturePlaybooks.createdAt,
  updatedAt: venturePlaybooks.updatedAt,
} as const;

/**
 * Insert a distilled playbook, or return the existing one for the same (workspace, dedupe_key) — the
 * idempotent distillation watermark, so re-distilling the same win never duplicates the pattern.
 */
export async function upsertPlaybook(input: {
  workspaceId: string;
  category: string;
  pattern: string;
  provenance: PlaybookProvenance[];
  dedupeKey: string;
}): Promise<{ playbook: PlaybookRecord; created: boolean }> {
  const inserted = await db
    .insert(venturePlaybooks)
    .values({
      workspaceId: input.workspaceId,
      category: input.category,
      pattern: input.pattern,
      provenance: input.provenance,
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing({
      target: [venturePlaybooks.workspaceId, venturePlaybooks.dedupeKey],
    })
    .returning(PLAYBOOK_COLS);
  if (inserted[0]) return { playbook: inserted[0] as PlaybookRecord, created: true };

  const [existing] = await db
    .select(PLAYBOOK_COLS)
    .from(venturePlaybooks)
    .where(
      and(
        eq(venturePlaybooks.workspaceId, input.workspaceId),
        eq(venturePlaybooks.dedupeKey, input.dedupeKey),
      ),
    )
    .limit(1);
  return { playbook: existing as PlaybookRecord, created: false };
}

/** Every playbook in a workspace (newest first), optionally narrowed to a category. */
export async function listPlaybooks(
  workspaceId: string,
  category?: string,
): Promise<PlaybookRecord[]> {
  const where = category
    ? and(eq(venturePlaybooks.workspaceId, workspaceId), eq(venturePlaybooks.category, category))
    : eq(venturePlaybooks.workspaceId, workspaceId);
  const rows = await db
    .select(PLAYBOOK_COLS)
    .from(venturePlaybooks)
    .where(where)
    .orderBy(desc(venturePlaybooks.createdAt))
    .limit(200);
  return rows as PlaybookRecord[];
}
