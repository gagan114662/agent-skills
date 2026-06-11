import { describe, it, expect } from "vitest";
import { MoatService, type MoatRepo } from "../../src/moat/service.js";
import { resolveMoatCaps } from "../../src/moat/caps.js";
import type { MoatAccrual, MoatLedgerEntry } from "../../src/moat/types.js";

const day = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-11T00:00:00.000Z");

/** An in-memory ledger fake. */
function fakeRepo(): MoatRepo & { rows: MoatLedgerEntry[] } {
  const rows: MoatLedgerEntry[] = [];
  let seq = 0;
  return {
    rows,
    async recordAccrual(input) {
      const row: MoatLedgerEntry = {
        id: `m${++seq}`,
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        dimension: input.dimension,
        magnitude: input.magnitude,
        unit: input.unit,
        description: input.description,
        provenance: input.provenance,
        sourceRef: input.sourceRef,
        createdByMemberId: input.createdByMemberId,
        createdAt: input.createdAt ?? NOW,
      };
      rows.push(row);
      return row;
    },
    async listAccruals(workspaceId, ventureIdeaId) {
      return rows.filter((r) => r.workspaceId === workspaceId && r.ventureIdeaId === ventureIdeaId);
    },
  };
}

function svc(repo: MoatRepo, capsCfg?: Parameters<typeof resolveMoatCaps>[0]) {
  return new MoatService({
    repo,
    caps: () => resolveMoatCaps(capsCfg),
    now: () => NOW,
  });
}

const accrual = (over: Partial<MoatAccrual> = {}): MoatAccrual => ({
  dimension: "proprietaryData",
  magnitude: 10,
  unit: "rows",
  description: "labeled outcomes",
  provenance: "pipeline:ingest",
  sourceRef: null,
  ...over,
});

describe("MoatService.record", () => {
  it("persists a ledger row attributed to the venture + member", async () => {
    const repo = fakeRepo();
    const entry = await svc(repo).record("ws1", "idea1", accrual(), "mem1");
    expect(entry.workspaceId).toBe("ws1");
    expect(entry.ventureIdeaId).toBe("idea1");
    expect(entry.createdByMemberId).toBe("mem1");
    expect(repo.rows).toHaveLength(1);
  });
});

describe("MoatService.scoreVenture", () => {
  it("scores an empty ledger as 0 and stagnant", async () => {
    const moat = await svc(fakeRepo()).scoreVenture("ws1", "idea1");
    expect(moat.score).toBe(0);
    expect(moat.stagnant).toBe(true);
    expect(moat.lastAccrualAtMs).toBeNull();
  });

  it("scores the ledger with the resolved weights and is not stagnant after a recent accrual", async () => {
    const repo = fakeRepo();
    const s = svc(repo);
    await s.record("ws1", "idea1", accrual({ dimension: "proprietaryData", magnitude: 50 }), null);
    await s.record("ws1", "idea1", accrual({ dimension: "switchingCosts", magnitude: 50 }), null);
    const moat = await s.scoreVenture("ws1", "idea1");
    expect(moat.score).toBeGreaterThan(0);
    expect(moat.dimensions.proprietaryData).toBeGreaterThan(0);
    expect(moat.dimensions.distributionLockIn).toBe(0);
    expect(moat.stagnant).toBe(false);
    expect(moat.accrualsInWindow).toBe(2);
  });

  it("is stagnant when the only accrual is older than the window", async () => {
    const repo = fakeRepo();
    await repo.recordAccrual({
      ...accrual(),
      workspaceId: "ws1",
      ventureIdeaId: "idea1",
      createdByMemberId: null,
      createdAt: new Date(NOW.getTime() - 40 * day),
    });
    const moat = await svc(repo, { stagnationWindowDays: 30 }).scoreVenture("ws1", "idea1");
    expect(moat.stagnant).toBe(true);
    expect(moat.accrualsInWindow).toBe(0);
    expect(moat.lastAccrualAtMs).toBe(NOW.getTime() - 40 * day);
  });
});

describe("MoatService.portfolioMoat", () => {
  it("scores every supplied venture, flagging the zero-accrual ones as stagnant", async () => {
    const repo = fakeRepo();
    const s = svc(repo);
    await s.record("ws1", "alive", accrual({ magnitude: 30 }), null);
    const portfolio = await s.portfolioMoat("ws1", ["alive", "dormant"]);
    const alive = portfolio.find((p) => p.ventureIdeaId === "alive")!;
    const dormant = portfolio.find((p) => p.ventureIdeaId === "dormant")!;
    expect(alive.stagnant).toBe(false);
    expect(alive.score).toBeGreaterThan(0);
    expect(dormant.stagnant).toBe(true);
    expect(dormant.score).toBe(0);
  });
});
