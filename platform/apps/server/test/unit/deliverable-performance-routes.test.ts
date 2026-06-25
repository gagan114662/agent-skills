import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const recordDeliverablePerformance = vi.fn();
const getDeliverablePerformance = vi.fn();
const listRankedDeliverablePerformance = vi.fn();

vi.mock("../../src/db/repositories/delivery.js", () => ({
  recordDeliverablePerformance,
  getDeliverablePerformance,
  listRankedDeliverablePerformance,
}));
vi.mock("../../src/db/schema/index.js", () => ({
  DELIVERABLE_PERFORMANCE_SOURCES: ["analytics", "search_console", "provider", "manual"],
}));
vi.mock("../../src/auth/guard.js", () => ({
  requireIdentity: vi.fn(async () => ({ workspaceId: "workspace-1", memberId: "member-1" })),
  assertWorkspace: vi.fn(
    (
      identity: { workspaceId: string },
      workspaceId: string,
      reply: { code: (n: number) => { send: (b: unknown) => void } },
    ) => {
      if (identity.workspaceId === workspaceId) return true;
      reply.code(403).send({ error: "wrong workspace" });
      return false;
    },
  ),
}));

const { deliverablePerformanceRoutes } = await import("../../src/routes/deliverable-performance.js");

const RECEIPT_ID = "11111111-2222-3333-4444-555555555555";

async function buildApp() {
  const app = Fastify();
  await app.register(deliverablePerformanceRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  recordDeliverablePerformance.mockReset();
  getDeliverablePerformance.mockReset();
  listRankedDeliverablePerformance.mockReset();
});

describe("deliverable performance routes (#869)", () => {
  it("records measured per-deliverable performance against a shipped receipt", async () => {
    recordDeliverablePerformance.mockResolvedValue({
      performance: {
        id: "perf-1",
        workspaceId: "workspace-1",
        deliveryReceiptId: RECEIPT_ID,
        source: "analytics",
        views: 120,
        engagements: 18,
        conversions: 3,
        externalMetricRef: "ga4:row-1",
        measuredAtMs: Date.parse("2026-06-24T10:00:00Z"),
        createdAtMs: Date.parse("2026-06-24T10:01:00Z"),
      },
    });
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/delivery/receipts/${RECEIPT_ID}/performance`,
      payload: {
        source: "analytics",
        views: 120,
        engagements: 18,
        conversions: 3,
        externalMetricRef: "ga4:row-1",
        measuredAt: "2026-06-24T10:00:00Z",
      },
    });

    expect(res.statusCode).toBe(202);
    expect(recordDeliverablePerformance).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      deliveryReceiptId: RECEIPT_ID,
      source: "analytics",
      views: 120,
      engagements: 18,
      conversions: 3,
      externalMetricRef: "ga4:row-1",
      measuredAt: new Date("2026-06-24T10:00:00Z"),
    });
    expect(res.json()).toMatchObject({ performance: { views: 120, engagements: 18, conversions: 3 } });
    await app.close();
  });

  it("returns one deliverable's performance summary for the current workspace", async () => {
    getDeliverablePerformance.mockResolvedValue({
      deliveryReceiptId: RECEIPT_ID,
      receipt: { id: RECEIPT_ID, externalRef: "https://example.com/post" },
      totals: { views: 10, engagements: 2, conversions: 1, engagementRate: 0.2, conversionRate: 0.1 },
      latest: { id: "perf-1" },
      readings: [{ id: "perf-1" }],
    });
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: `/me/deliverables/${RECEIPT_ID}/performance` });

    expect(res.statusCode).toBe(200);
    expect(getDeliverablePerformance).toHaveBeenCalledWith("workspace-1", RECEIPT_ID);
    expect(res.json()).toMatchObject({ performance: { totals: { views: 10, conversions: 1 } } });
    await app.close();
  });

  it("returns ranked deliverables by performance", async () => {
    listRankedDeliverablePerformance.mockResolvedValue([
      { deliveryReceiptId: "r1", views: 100, engagements: 20, conversions: 4 },
      { deliveryReceiptId: "r2", views: 200, engagements: 10, conversions: 1 },
    ]);
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/me/deliverables/performance" });

    expect(res.statusCode).toBe(200);
    expect(listRankedDeliverablePerformance).toHaveBeenCalledWith("workspace-1");
    expect(res.json()).toMatchObject({ deliverables: [{ deliveryReceiptId: "r1" }, { deliveryReceiptId: "r2" }] });
    await app.close();
  });

  it("rejects negative measured counts before writing", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/delivery/receipts/${RECEIPT_ID}/performance`,
      payload: { views: -1, engagements: 0, conversions: 0 },
    });

    expect(res.statusCode).toBe(400);
    expect(recordDeliverablePerformance).not.toHaveBeenCalled();
    await app.close();
  });
});
