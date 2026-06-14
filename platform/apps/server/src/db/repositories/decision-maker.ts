import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { buyerBriefs } from "../schema/index.js";
import type { AngleHook, BuyerBrief, BuyerBriefRecord, BuyerRole } from "../../decision-maker/types.js";

/**
 * Decision-maker resolver repository (#223, ADR-0223). Workspace-scoped throughout (the #3 IDOR
 * discipline); the pure resolution/brief logic lives in `../../decision-maker/` — this is persistence only.
 */

const BRIEF_COLS = {
  id: buyerBriefs.id,
  workspaceId: buyerBriefs.workspaceId,
  ideaId: buyerBriefs.ideaId,
  accountId: buyerBriefs.accountId,
  accountName: buyerBriefs.accountName,
  accountDomain: buyerBriefs.accountDomain,
  buyerContactId: buyerBriefs.buyerContactId,
  buyerName: buyerBriefs.buyerName,
  buyerTitle: buyerBriefs.buyerTitle,
  buyerRole: buyerBriefs.buyerRole,
  rationale: buyerBriefs.rationale,
  caresAbout: buyerBriefs.caresAbout,
  hooks: buyerBriefs.hooks,
  fallbackTrail: buyerBriefs.fallbackTrail,
  createdAt: buyerBriefs.createdAt,
} as const;

/** Shape a selected row into the {@link BuyerBriefRecord} the service speaks. */
function toRecord(row: Record<string, unknown>): BuyerBriefRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    ideaId: (row.ideaId as string | null) ?? null,
    accountId: row.accountId as string,
    accountName: row.accountName as string,
    accountDomain: row.accountDomain as string,
    buyerContactId: row.buyerContactId as string,
    buyerName: row.buyerName as string,
    buyerTitle: row.buyerTitle as string,
    buyerRole: row.buyerRole as BuyerRole,
    rationale: row.rationale as string,
    caresAbout: (row.caresAbout as string[] | null) ?? [],
    hooks: (row.hooks as AngleHook[] | null) ?? [],
    fallbackTrail: (row.fallbackTrail as BuyerRole[] | null) ?? [],
    createdAt: row.createdAt as Date,
  };
}

export async function insertBuyerBrief(input: {
  workspaceId: string;
  ideaId: string | null;
  brief: BuyerBrief;
}): Promise<BuyerBriefRecord> {
  const b = input.brief;
  const [row] = await db
    .insert(buyerBriefs)
    .values({
      workspaceId: input.workspaceId,
      ideaId: input.ideaId,
      accountId: b.accountId,
      accountName: b.accountName,
      accountDomain: b.accountDomain,
      buyerContactId: b.buyerContactId,
      buyerName: b.buyerName,
      buyerTitle: b.buyerTitle,
      buyerRole: b.buyerRole,
      rationale: b.rationale,
      caresAbout: b.caresAbout,
      hooks: b.hooks,
      fallbackTrail: b.fallbackTrail,
    })
    .returning(BRIEF_COLS);
  return toRecord(row as Record<string, unknown>);
}

/** Every buyer brief for a workspace, newest first. Workspace-scoped. */
export async function listBuyerBriefs(workspaceId: string): Promise<BuyerBriefRecord[]> {
  const rows = await db
    .select(BRIEF_COLS)
    .from(buyerBriefs)
    .where(eq(buyerBriefs.workspaceId, workspaceId))
    .orderBy(desc(buyerBriefs.createdAt))
    .limit(100);
  return rows.map((r) => toRecord(r as Record<string, unknown>));
}

export async function getBuyerBrief(
  workspaceId: string,
  id: string,
): Promise<BuyerBriefRecord | undefined> {
  const [row] = await db
    .select(BRIEF_COLS)
    .from(buyerBriefs)
    .where(and(eq(buyerBriefs.workspaceId, workspaceId), eq(buyerBriefs.id, id)))
    .limit(1);
  return row ? toRecord(row as Record<string, unknown>) : undefined;
}
