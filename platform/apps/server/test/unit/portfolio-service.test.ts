import { describe, it, expect } from "vitest";
import {
  PortfolioService,
  PortfolioReviewNotFoundError,
  PortfolioNotSunsetError,
  PortfolioSunsetStateError,
  PortfolioSunsetNotApprovedError,
  type PortfolioDeps,
  type LaunchedVenture,
} from "../../src/portfolio/service.js";
import { resolvePortfolioCaps } from "../../src/portfolio/caps.js";
import type { PortfolioReviewRecord } from "../../src/portfolio/types.js";

const WID = "ws-1";
const NOW = new Date("2026-06-11T00:00:00.000Z");
const DAY = 86_400_000;

/** Per-venture KPI inputs the fake readers serve. */
interface VentureFixture {
  ventureIdeaId: string;
  launchedDaysAgo: number;
  growthScore: number;
  moatScore: number;
  moatStagnant: boolean;
  demandSignals: number;
}

interface Harness {
  service: PortfolioService;
  rows: PortfolioReviewRecord[];
  memos: { ventureIdeaId: string; reasoning: string }[];
  killed: string[];
  approvals: Map<string, string>; // approvalRequestId -> status
  setApprovalStatus(id: string, status: string): void;
}

function harness(
  fixtures: VentureFixture[],
  opts: {
    revenueCents?: number;
    revenueByVenture?: Record<string, number>;
    monthlyCostCents?: number;
    requiresApproval?: boolean;
    capsCfg?: Parameters<typeof resolvePortfolioCaps>[0];
  } = {},
): Harness {
  const rows: PortfolioReviewRecord[] = [];
  const memos: { ventureIdeaId: string; reasoning: string }[] = [];
  const killed: string[] = [];
  const approvals = new Map<string, string>();
  let seq = 0;
  const byId = new Map(fixtures.map((f) => [f.ventureIdeaId, f]));

  const launched: LaunchedVenture[] = fixtures.map((f) => ({
    ventureIdeaId: f.ventureIdeaId,
    launchedAt: new Date(NOW.getTime() - f.launchedDaysAgo * DAY),
  }));

  const deps: PortfolioDeps = {
    launch: { launched: async () => launched },
    growth: { score: async (_w, vid) => byId.get(vid)?.growthScore ?? 0 },
    moat: {
      portfolio: async (_w, ids) =>
        ids.map((vid) => ({
          ventureIdeaId: vid,
          score: byId.get(vid)?.moatScore ?? 0,
          stagnant: byId.get(vid)?.moatStagnant ?? true,
        })),
    },
    demand: { signalCount: async (_w, vid) => byId.get(vid)?.demandSignals ?? 0 },
    revenue: {
      ventureVerifiedRevenueCents: async (_w, vid) =>
        opts.revenueByVenture?.[vid] ?? opts.revenueCents ?? 0,
    },
    cost: { monthlyCostCents: async () => opts.monthlyCostCents ?? 0 },
    store: {
      insert: async (input) => {
        const row: PortfolioReviewRecord = {
          id: `r${++seq}`,
          status: "recorded",
          approvalRequestId: null,
          createdAt: NOW,
          ...input,
        };
        rows.push(row);
        return row;
      },
      list: async (wid) => rows.filter((r) => r.workspaceId === wid),
      get: async (wid, id) => rows.find((r) => r.workspaceId === wid && r.id === id),
      setSunset: async (wid, id, patch) => {
        const row = rows.find((r) => r.workspaceId === wid && r.id === id);
        if (!row) return undefined;
        row.status = patch.status;
        if (patch.approvalRequestId !== undefined) row.approvalRequestId = patch.approvalRequestId;
        return row;
      },
    },
    gate: {
      requiresApproval: async () => opts.requiresApproval ?? true,
      submit: async () => {
        const id = `appr-${++seq}`;
        approvals.set(id, "pending");
        return { id };
      },
      status: async (id) => approvals.get(id),
    },
    memory: {
      recordSunset: async (input) =>
        void memos.push({ ventureIdeaId: input.ventureIdeaId, reasoning: input.reasoning }),
    },
    venture: { markKilled: async (_w, vid) => void killed.push(vid) },
    caps: () => resolvePortfolioCaps(opts.capsCfg),
    now: () => NOW,
  };

  return {
    service: new PortfolioService(deps),
    rows,
    memos,
    killed,
    approvals,
    setApprovalStatus: (id, status) => approvals.set(id, status),
  };
}

const HEALTHY: VentureFixture = {
  ventureIdeaId: "v-healthy",
  launchedDaysAgo: 60,
  growthScore: 95,
  moatScore: 90,
  moatStagnant: false,
  demandSignals: 5,
};
const DEAD: VentureFixture = {
  ventureIdeaId: "v-dead",
  launchedDaysAgo: 60,
  growthScore: 0,
  moatScore: 0,
  moatStagnant: true,
  demandSignals: 0,
};

describe("PortfolioService.reviewPortfolio", () => {
  it("persists one review per launched venture, snapshotting the gathered evidence", async () => {
    const h = harness([HEALTHY, DEAD], {
      revenueByVenture: { "v-healthy": 50_00, "v-dead": 0 },
      monthlyCostCents: 1_00,
    });
    const reviews = await h.service.reviewPortfolio(WID);
    expect(reviews).toHaveLength(2);
    expect(h.rows).toHaveLength(2);

    const healthy = h.rows.find((r) => r.ventureIdeaId === "v-healthy")!;
    expect(healthy.decision).toBe("DOUBLE_DOWN");
    expect(healthy.growthScore).toBe(95);
    expect(healthy.moatScore).toBe(90);
    expect(healthy.demandSignals).toBe(5);
    expect(healthy.revenueCents).toBe(50_00);
    expect(healthy.monthlyCostCents).toBe(1_00);
    expect(healthy.netCents).toBe(49_00);
    expect(healthy.ageInDays).toBe(60);
    expect(healthy.status).toBe("recorded");
    expect(healthy.reasons.join(" ")).toContain("10000bps of portfolio receipts");

    const dead = h.rows.find((r) => r.ventureIdeaId === "v-dead")!;
    expect(dead.revenueCents).toBe(0);
    expect(dead.reasons.join(" ")).toContain("0bps of portfolio receipts");
  });

  it("computes ageInDays from launchedAt and the injected clock", async () => {
    const h = harness([{ ...HEALTHY, launchedDaysAgo: 3 }]);
    await h.service.reviewPortfolio(WID);
    // 3-day-old launch is inside the 14d grace window → MAINTAIN regardless of score.
    expect(h.rows[0].ageInDays).toBe(3);
    expect(h.rows[0].decision).toBe("MAINTAIN");
  });

  it("returns an empty list and writes nothing when there are no launched ventures", async () => {
    const h = harness([]);
    expect(await h.service.reviewPortfolio(WID)).toEqual([]);
    expect(h.rows).toHaveLength(0);
  });
});

describe("PortfolioService SUNSET lifecycle — gated by default", () => {
  async function seedSunset(h: Harness): Promise<string> {
    // DEAD venture (health 0) burning money → SUNSET decision recorded.
    await h.service.reviewPortfolio(WID);
    const review = h.rows.find((r) => r.decision === "SUNSET")!;
    expect(review).toBeTruthy();
    return review.id;
  }

  it("requestSunset creates a pending #13 request and does NOT kill or write memory", async () => {
    const h = harness([DEAD], { monthlyCostCents: 5_00 });
    const id = await seedSunset(h);
    const res = await h.service.requestSunset(WID, id, { requesterMemberId: "m1" });

    expect(res.gated).toBe(true);
    expect(res.approvalRequestId).toMatch(/^appr-/);
    expect(h.rows.find((r) => r.id === id)!.status).toBe("sunset_pending");
    expect(h.killed).toEqual([]); // no teardown before approval
    expect(h.memos).toEqual([]); // no post-mortem before approval
  });

  it("executeSunset is blocked while the approval is still pending", async () => {
    const h = harness([DEAD], { monthlyCostCents: 5_00 });
    const id = await seedSunset(h);
    await h.service.requestSunset(WID, id, { requesterMemberId: "m1" });
    await expect(h.service.executeSunset(WID, id, { actorMemberId: "m1" })).rejects.toBeInstanceOf(
      PortfolioSunsetNotApprovedError,
    );
    expect(h.killed).toEqual([]);
  });

  it("executeSunset kills the venture + writes the post-mortem once approved", async () => {
    const h = harness([DEAD], { monthlyCostCents: 5_00 });
    const id = await seedSunset(h);
    const { approvalRequestId } = await h.service.requestSunset(WID, id, {
      requesterMemberId: "m1",
    });
    h.setApprovalStatus(approvalRequestId!, "approved");

    const res = await h.service.executeSunset(WID, id, { actorMemberId: "m2" });
    expect(res.executed).toBe(true);
    expect(h.rows.find((r) => r.id === id)!.status).toBe("sunset_executed");
    expect(h.killed).toEqual(["v-dead"]);
    expect(h.memos).toHaveLength(1);
    expect(h.memos[0].ventureIdeaId).toBe("v-dead");
    expect(h.memos[0].reasoning.toLowerCase()).toContain("sunset");
  });

  it("executeSunset marks the review rejected when the approval was rejected (no kill)", async () => {
    const h = harness([DEAD], { monthlyCostCents: 5_00 });
    const id = await seedSunset(h);
    const { approvalRequestId } = await h.service.requestSunset(WID, id, {
      requesterMemberId: "m1",
    });
    h.setApprovalStatus(approvalRequestId!, "rejected");

    const res = await h.service.executeSunset(WID, id, { actorMemberId: "m2" });
    expect(res.executed).toBe(false);
    expect(h.rows.find((r) => r.id === id)!.status).toBe("sunset_rejected");
    expect(h.killed).toEqual([]);
  });
});

describe("PortfolioService SUNSET lifecycle — opt-out", () => {
  it("auto-executes the sunset when a workspace rule opts portfolio.sunset out of approval", async () => {
    const h = harness([DEAD], { monthlyCostCents: 5_00, requiresApproval: false });
    await h.service.reviewPortfolio(WID);
    const id = h.rows.find((r) => r.decision === "SUNSET")!.id;
    const res = await h.service.requestSunset(WID, id, { requesterMemberId: "m1" });

    expect(res.gated).toBe(false);
    expect(h.rows.find((r) => r.id === id)!.status).toBe("sunset_executed");
    expect(h.killed).toEqual(["v-dead"]);
    expect(h.memos).toHaveLength(1);
  });
});

describe("PortfolioService guards", () => {
  it("requestSunset throws for an unknown review", async () => {
    const h = harness([]);
    await expect(
      h.service.requestSunset(WID, "nope", { requesterMemberId: "m1" }),
    ).rejects.toBeInstanceOf(PortfolioReviewNotFoundError);
  });

  it("requestSunset refuses a non-SUNSET review", async () => {
    const h = harness([HEALTHY], { revenueCents: 100_00 });
    await h.service.reviewPortfolio(WID);
    const id = h.rows[0].id; // DOUBLE_DOWN
    await expect(
      h.service.requestSunset(WID, id, { requesterMemberId: "m1" }),
    ).rejects.toBeInstanceOf(PortfolioNotSunsetError);
  });

  it("requestSunset refuses a review that is already pending/executed", async () => {
    const h = harness([DEAD], { monthlyCostCents: 5_00 });
    await h.service.reviewPortfolio(WID);
    const id = h.rows.find((r) => r.decision === "SUNSET")!.id;
    await h.service.requestSunset(WID, id, { requesterMemberId: "m1" });
    await expect(
      h.service.requestSunset(WID, id, { requesterMemberId: "m1" }),
    ).rejects.toBeInstanceOf(PortfolioSunsetStateError);
  });
});
