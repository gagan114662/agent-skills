import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { db } from "../index.js";
import { financeLedgerEntries, financeClosePacks } from "../schema/index.js";
import type { ClosePack, LedgerEntry, LedgerPosting, UnitEconomics } from "../../finance/ledger.js";
import type { FinanceStore, LedgerFilter, StoredClosePack } from "../../finance/service.js";

/**
 * Repository-backed finance store implementing the injectable {@link FinanceStore} seam (#194), so the
 * FinanceService persists durably in production while unit tests inject an in-memory store. Reads are
 * **workspace-scoped** (IDOR-safe, #9). Ledger idempotency is the unique `(workspace_id, source,
 * source_ref)` constraint — `postEntry` upserts, so the engine re-posting every tick never double-counts.
 */

/** The half-open `[start, nextMonth)` instant range a `YYYY-MM` period covers, for an `occurred_at` filter. */
function periodRange(periodKey: string): { start: Date; end: Date } {
  const [y, m] = periodKey.split("-").map((n) => Number(n));
  return { start: new Date(Date.UTC(y!, m! - 1, 1)), end: new Date(Date.UTC(y!, m!, 1)) };
}

function toEntry(row: typeof financeLedgerEntries.$inferSelect): LedgerEntry {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ventureIdeaId: row.ventureIdeaId,
    direction: row.direction,
    category: row.category,
    amountCents: row.amountCents,
    currency: row.currency,
    verified: row.verified,
    source: row.source,
    sourceRef: row.sourceRef,
    occurredAtMs: row.occurredAt.getTime(),
    memo: row.memo,
    createdAtMs: row.createdAt.getTime(),
  };
}

function toPack(row: typeof financeClosePacks.$inferSelect): StoredClosePack {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ventureIdeaId: row.ventureIdeaId,
    periodKey: row.periodKey,
    currency: row.currency,
    revenueCents: row.revenueCents,
    costCents: row.costCents,
    verifiedCostCents: row.verifiedCostCents,
    netCents: row.netCents,
    verifiedRevenueCents: row.verifiedRevenueCents,
    verifiedShareBps: row.verifiedShareBps,
    entryCount: row.entryCount,
    unitEconomics: row.unitEconomics as UnitEconomics,
    closedAtMs: row.closedAt.getTime(),
  };
}

export const dbFinanceStore: FinanceStore = {
  async postEntry(posting: LedgerPosting): Promise<LedgerEntry> {
    const [row] = await db
      .insert(financeLedgerEntries)
      .values({
        workspaceId: posting.workspaceId,
        ventureIdeaId: posting.ventureIdeaId,
        direction: posting.direction,
        category: posting.category,
        amountCents: posting.amountCents,
        currency: posting.currency,
        verified: posting.verified,
        source: posting.source,
        sourceRef: posting.sourceRef,
        occurredAt: new Date(posting.occurredAtMs),
        memo: posting.memo,
      })
      .onConflictDoUpdate({
        target: [financeLedgerEntries.workspaceId, financeLedgerEntries.source, financeLedgerEntries.sourceRef],
        set: {
          ventureIdeaId: posting.ventureIdeaId,
          direction: posting.direction,
          category: posting.category,
          amountCents: posting.amountCents,
          currency: posting.currency,
          verified: posting.verified,
          occurredAt: new Date(posting.occurredAtMs),
          memo: posting.memo,
        },
      })
      .returning();
    return toEntry(row!);
  },

  async listEntries(workspaceId: string, filter?: LedgerFilter): Promise<LedgerEntry[]> {
    const conds = [eq(financeLedgerEntries.workspaceId, workspaceId)];
    if (filter?.ventureIdeaId === null) conds.push(isNull(financeLedgerEntries.ventureIdeaId));
    else if (typeof filter?.ventureIdeaId === "string")
      conds.push(eq(financeLedgerEntries.ventureIdeaId, filter.ventureIdeaId));
    if (filter?.periodKey) {
      const { start, end } = periodRange(filter.periodKey);
      conds.push(gte(financeLedgerEntries.occurredAt, start), lt(financeLedgerEntries.occurredAt, end));
    }
    const rows = await db
      .select()
      .from(financeLedgerEntries)
      .where(and(...conds))
      .orderBy(desc(financeLedgerEntries.occurredAt))
      .limit(filter?.limit ?? 500);
    return rows.map(toEntry);
  },

  async upsertClosePack(pack: ClosePack): Promise<StoredClosePack> {
    const scopeMatch =
      pack.ventureIdeaId === null
        ? isNull(financeClosePacks.ventureIdeaId)
        : eq(financeClosePacks.ventureIdeaId, pack.ventureIdeaId);
    const values = {
      currency: pack.currency,
      revenueCents: pack.revenueCents,
      costCents: pack.costCents,
      verifiedRevenueCents: pack.verifiedRevenueCents,
      verifiedCostCents: pack.verifiedCostCents,
      netCents: pack.netCents,
      verifiedShareBps: pack.verifiedShareBps,
      entryCount: pack.entryCount,
      unitEconomics: pack.unitEconomics,
      closedAt: new Date(),
    };
    const [existing] = await db
      .select({ id: financeClosePacks.id })
      .from(financeClosePacks)
      .where(
        and(
          eq(financeClosePacks.workspaceId, pack.workspaceId),
          eq(financeClosePacks.periodKey, pack.periodKey),
          scopeMatch,
        ),
      )
      .limit(1);
    if (existing) {
      const [row] = await db
        .update(financeClosePacks)
        .set(values)
        .where(eq(financeClosePacks.id, existing.id))
        .returning();
      return toPack(row!);
    }
    const [row] = await db
      .insert(financeClosePacks)
      .values({
        workspaceId: pack.workspaceId,
        ventureIdeaId: pack.ventureIdeaId,
        periodKey: pack.periodKey,
        ...values,
      })
      .returning();
    return toPack(row!);
  },

  async listClosePacks(
    workspaceId: string,
    filter?: { periodKey?: string; ventureIdeaId?: string | null },
  ): Promise<StoredClosePack[]> {
    const conds = [eq(financeClosePacks.workspaceId, workspaceId)];
    if (filter?.periodKey) conds.push(eq(financeClosePacks.periodKey, filter.periodKey));
    if (filter?.ventureIdeaId === null) conds.push(isNull(financeClosePacks.ventureIdeaId));
    else if (typeof filter?.ventureIdeaId === "string")
      conds.push(eq(financeClosePacks.ventureIdeaId, filter.ventureIdeaId));
    const rows = await db
      .select()
      .from(financeClosePacks)
      .where(and(...conds))
      .orderBy(desc(financeClosePacks.periodKey));
    return rows.map(toPack);
  },
};
