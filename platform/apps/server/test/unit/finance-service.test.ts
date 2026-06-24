import { describe, it, expect, beforeEach } from "vitest";
import { newId } from "../../src/db/id.js";
import {
  FinanceService,
  type ClosePackFilter,
  type FinanceStore,
  type StoredClosePack,
  type LedgerFilter,
} from "../../src/finance/service.js";
import { FinanceLedgerEngine } from "../../src/finance/engine.js";
import { FINANCE_DEFAULTS, type FinanceCaps } from "../../src/finance/caps.js";
import { periodKeyOf, type ClosePack, type LedgerEntry, type LedgerPosting, type RevenueReceipt } from "../../src/finance/ledger.js";

/** In-memory FinanceStore mirroring the repo's upsert idempotency on (workspace, source, sourceRef). */
class MemoryFinanceStore implements FinanceStore {
  entries: LedgerEntry[] = [];
  packs: StoredClosePack[] = [];
  closePackReads: ClosePackFilter[] = [];

  async postEntry(posting: LedgerPosting): Promise<LedgerEntry> {
    const key = `${posting.workspaceId}|${posting.source}|${posting.sourceRef}`;
    const existing = this.entries.find((e) => `${e.workspaceId}|${e.source}|${e.sourceRef}` === key);
    if (existing) {
      Object.assign(existing, posting);
      return existing;
    }
    const entry: LedgerEntry = { ...posting, id: newId(), createdAtMs: posting.occurredAtMs };
    this.entries.push(entry);
    return entry;
  }

  async listEntries(workspaceId: string, filter?: LedgerFilter): Promise<LedgerEntry[]> {
    let rows = this.entries.filter((e) => e.workspaceId === workspaceId);
    if (filter?.ventureIdeaId === null) rows = rows.filter((e) => e.ventureIdeaId === null);
    else if (typeof filter?.ventureIdeaId === "string") rows = rows.filter((e) => e.ventureIdeaId === filter.ventureIdeaId);
    if (filter?.periodKey) rows = rows.filter((e) => periodKeyOf(e.occurredAtMs) === filter.periodKey);
    rows = [...rows].sort((a, b) => b.occurredAtMs - a.occurredAtMs);
    return filter?.limit ? rows.slice(0, filter.limit) : rows;
  }

  async upsertClosePack(pack: ClosePack): Promise<StoredClosePack> {
    const match = (p: StoredClosePack) =>
      p.workspaceId === pack.workspaceId && p.periodKey === pack.periodKey && p.ventureIdeaId === pack.ventureIdeaId;
    const existing = this.packs.find(match);
    if (existing) {
      Object.assign(existing, pack, { closedAtMs: existing.closedAtMs });
      return existing;
    }
    const stored: StoredClosePack = { ...pack, id: newId(), closedAtMs: Date.parse("2026-02-20T00:00:00Z") };
    this.packs.push(stored);
    return stored;
  }

  async listClosePacks(workspaceId: string, filter?: ClosePackFilter): Promise<StoredClosePack[]> {
    this.closePackReads.push(filter ?? {});
    let rows = this.packs.filter((p) => p.workspaceId === workspaceId);
    if (filter?.periodKey) rows = rows.filter((p) => p.periodKey === filter.periodKey);
    if (filter?.periodKeys) rows = rows.filter((p) => filter.periodKeys!.includes(p.periodKey));
    if (filter?.ventureIdeaId === null) rows = rows.filter((p) => p.ventureIdeaId === null);
    else if (typeof filter?.ventureIdeaId === "string") rows = rows.filter((p) => p.ventureIdeaId === filter.ventureIdeaId);
    const sorted = [...rows].sort((a, b) => (a.periodKey < b.periodKey ? 1 : -1));
    return filter?.limit ? sorted.slice(0, filter.limit) : sorted;
  }

  async sumClosePackNet(workspaceId: string, filter?: { ventureIdeaId?: string | null }): Promise<number> {
    let rows = this.packs.filter((p) => p.workspaceId === workspaceId);
    if (filter?.ventureIdeaId === null) rows = rows.filter((p) => p.ventureIdeaId === null);
    else if (typeof filter?.ventureIdeaId === "string") rows = rows.filter((p) => p.ventureIdeaId === filter.ventureIdeaId);
    return rows.reduce((sum, p) => sum + p.netCents, 0);
  }
}

const FEB = new Date("2026-02-15T00:00:00Z");
const WS = "ws-fin";

function makeService(opts: {
  store: MemoryFinanceStore;
  receipts: RevenueReceipt[];
  usageCents: number;
  caps?: Partial<FinanceCaps>;
  now?: Date;
}): FinanceService {
  return new FinanceService({
    store: opts.store,
    revenue: { listReceipts: async () => opts.receipts },
    usage: { window: (n) => `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}`, estimatedCostCents: async () => opts.usageCents },
    caps: () => ({ ...FINANCE_DEFAULTS, enabled: true, ...opts.caps }),
    currency: () => "usd",
    now: () => opts.now ?? FEB,
  });
}

describe("FinanceService.sync", () => {
  let store: MemoryFinanceStore;
  beforeEach(() => {
    store = new MemoryFinanceStore();
  });

  it("posts revenue events as verified credits and the usage window as one UNVERIFIED debit", async () => {
    const svc = makeService({
      store,
      receipts: [
        { providerEventId: "e1", amountCents: 10000, currency: "usd", createdAtMs: FEB.getTime() },
        { providerEventId: "e2", amountCents: 5000, currency: "usd", createdAtMs: FEB.getTime() },
      ],
      usageCents: 4000,
    });
    const r = await svc.sync(WS);
    expect(r).toMatchObject({ revenuePosted: 2, costPosted: 1, periodKey: "2026-02" });
    expect(store.entries.filter((e) => e.verified)).toHaveLength(2);
    const cost = store.entries.find((e) => e.source === "tenant_usage")!;
    expect(cost).toMatchObject({ direction: "debit", verified: false, sourceRef: "2026-02" });
  });

  it("is idempotent — re-syncing the same receipts does not double-count", async () => {
    const svc = makeService({ store, receipts: [{ providerEventId: "e1", amountCents: 10000, currency: "usd", createdAtMs: FEB.getTime() }], usageCents: 4000 });
    await svc.sync(WS);
    await svc.sync(WS);
    expect(store.entries).toHaveLength(2); // 1 revenue + 1 usage, not 4
  });

  it("posts no cost entry when the usage estimate is 0 (rate unset → no fabricated cost)", async () => {
    const svc = makeService({ store, receipts: [], usageCents: 0 });
    const r = await svc.sync(WS);
    expect(r.costPosted).toBe(0);
    expect(store.entries).toHaveLength(0);
  });
});

describe("FinanceService.close + runway", () => {
  it("closes the workspace book with verified-share accounting", async () => {
    const store = new MemoryFinanceStore();
    const svc = makeService({ store, receipts: [{ providerEventId: "e1", amountCents: 15000, currency: "usd", createdAtMs: FEB.getTime() }], usageCents: 4000 });
    await svc.sync(WS);
    const packs = await svc.close(WS);
    expect(packs).toHaveLength(1); // workspace-level only (no venture attribution)
    expect(packs[0]).toMatchObject({ revenueCents: 15000, costCents: 4000, netCents: 11000, ventureIdeaId: null });
    expect(packs[0]!.verifiedShareBps).toBe(7895);
  });

  it("forecasts runway + breach from the closed books", async () => {
    const store = new MemoryFinanceStore();
    // Two prior burning months closed at workspace level + a thin cash position.
    store.packs.push(
      { id: newId(), workspaceId: WS, ventureIdeaId: null, periodKey: "2025-12", currency: "usd", revenueCents: 0, costCents: 10000, verifiedRevenueCents: 0, verifiedCostCents: 0, netCents: -10000, verifiedShareBps: 0, entryCount: 1, unitEconomics: { cacCents: null, ltvCents: null, marginBps: null, ltvToCacX100: null }, closedAtMs: 0 },
      { id: newId(), workspaceId: WS, ventureIdeaId: null, periodKey: "2026-01", currency: "usd", revenueCents: 0, costCents: 10000, verifiedRevenueCents: 0, verifiedCostCents: 0, netCents: -10000, verifiedShareBps: 0, entryCount: 1, unitEconomics: { cacCents: null, ltvCents: null, marginBps: null, ltvToCacX100: null }, closedAtMs: 0 },
    );
    const svc = makeService({ store, receipts: [], usageCents: 0, caps: { lookbackMonths: 2 } });
    const f = await svc.runway(WS);
    expect(f.cashPositionCents).toBe(-20000); // sum of closed nets
    expect(f.monthlyBurnCents).toBe(10000); // mean over the 2-month lookback (both burning -10000)
    expect(f.health).toBe("breached"); // already below floor 0
  });

  it("computes runway without loading historical close packs (#988)", async () => {
    const store = new MemoryFinanceStore();
    const unitEconomics = { cacCents: null, ltvCents: null, marginBps: null, ltvToCacX100: null };
    for (let i = 1; i <= 12; i += 1) {
      const month = String(i).padStart(2, "0");
      store.packs.push({
        id: newId(),
        workspaceId: WS,
        ventureIdeaId: null,
        periodKey: `2025-${month}`,
        currency: "usd",
        revenueCents: 0,
        costCents: 100,
        verifiedRevenueCents: 0,
        verifiedCostCents: 0,
        netCents: -100,
        verifiedShareBps: 0,
        entryCount: 1,
        unitEconomics,
        closedAtMs: 0,
      });
    }
    store.packs.push({
      id: newId(),
      workspaceId: WS,
      ventureIdeaId: null,
      periodKey: "2026-01",
      currency: "usd",
      revenueCents: 0,
      costCents: 200,
      verifiedRevenueCents: 0,
      verifiedCostCents: 0,
      netCents: -200,
      verifiedShareBps: 0,
      entryCount: 1,
      unitEconomics,
      closedAtMs: 0,
    });
    const svc = makeService({ store, receipts: [], usageCents: 0, caps: { lookbackMonths: 2 } });

    const f = await svc.runway(WS);

    expect(f.cashPositionCents).toBe(-1400);
    expect(f.monthlyBurnCents).toBe(150);
    expect(store.closePackReads).toEqual([
      { ventureIdeaId: null, periodKeys: ["2025-12", "2026-01"], limit: 2 },
    ]);
  });
});

describe("FinanceLedgerEngine", () => {
  it("skips a workspace when finance is disabled", async () => {
    const store = new MemoryFinanceStore();
    const svc = makeService({ store, receipts: [{ providerEventId: "e1", amountCents: 100, currency: "usd", createdAtMs: FEB.getTime() }], usageCents: 0, caps: { enabled: false } });
    const engine = new FinanceLedgerEngine({
      service: svc,
      listWorkspaceIds: async () => [WS],
      caps: () => ({ ...FINANCE_DEFAULTS, enabled: false }),
      logger: { info() {}, warn() {}, error() {} } as never,
    });
    const r = await engine.tickWorkspace(WS);
    expect(r).toMatchObject({ revenuePosted: 0, costPosted: 0, closed: 0 });
    expect(store.entries).toHaveLength(0);
  });

  it("syncs + closes when enabled, and the maintenance pause skips the whole pass", async () => {
    const store = new MemoryFinanceStore();
    const svc = makeService({ store, receipts: [{ providerEventId: "e1", amountCents: 100, currency: "usd", createdAtMs: FEB.getTime() }], usageCents: 0 });
    const caps = () => ({ ...FINANCE_DEFAULTS, enabled: true });
    const engine = new FinanceLedgerEngine({
      service: svc,
      listWorkspaceIds: async () => [WS],
      caps,
      maintenancePaused: async () => true,
      logger: { info() {}, warn() {}, error() {} } as never,
    });
    await engine.tickAll();
    expect(store.entries).toHaveLength(0); // maintenance paused the whole pass

    const engine2 = new FinanceLedgerEngine({ service: svc, listWorkspaceIds: async () => [WS], caps, logger: { info() {}, warn() {}, error() {} } as never });
    const r = await engine2.tickWorkspace(WS);
    expect(r.revenuePosted).toBe(1);
    expect(r.closed).toBe(1);
  });
});
