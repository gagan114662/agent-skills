import { describe, it, expect } from "vitest";
import {
  GrowthReportService,
  GrowthReportError,
  weekPeriodContaining,
} from "../../src/growth-report/service.js";
import { InMemoryGrowthReportStore, reportId } from "../../src/growth-report/store.js";
import { StaticGrowthDataSource } from "../../src/growth-report/source.js";
import type { GrowthReportCaps } from "../../src/growth-report/caps.js";
import type { WeeklyGrowthData } from "../../src/growth-report/types.js";

/**
 * Unit tests of {@link GrowthReportService} over the in-memory store + a static data source — no DB, no
 * clock. Covers: the disabled-gate, generate persists a synthesized report, the weekly tick is idempotent,
 * list/latest ordering, and workspace (IDOR) scoping.
 */

const ENABLED: GrowthReportCaps = { enabled: true, maxNextBets: 5 };
const DISABLED: GrowthReportCaps = { enabled: false, maxNextBets: 5 };
const PERIOD = { weekStart: "2026-06-15", weekEnd: "2026-06-22" };

function dataFor(workspaceId: string): WeeklyGrowthData {
  return {
    workspaceId,
    period: PERIOD,
    metrics: [{ key: "signups", label: "Signups", value: 120, priorValue: 100 }],
    experiments: [{ id: "e1", name: "Exp", hypothesis: "h", status: "win", metricKey: "signups", lift: 0.2 }],
  };
}

function makeService(caps: GrowthReportCaps = ENABLED, clockMs = Date.UTC(2026, 5, 17)) {
  const store = new InMemoryGrowthReportStore();
  const dataSource = new StaticGrowthDataSource(new Map([["ws-1", dataFor("ws-1")], ["ws-2", dataFor("ws-2")]]));
  const service = new GrowthReportService({ store, dataSource, caps, now: () => new Date(clockMs) });
  return { store, dataSource, service };
}

describe("weekPeriodContaining", () => {
  it("returns the Monday-to-Monday (UTC) week for a mid-week date", () => {
    // 2026-06-17 is a Wednesday → week starts Monday 2026-06-15, ends Monday 2026-06-22.
    expect(weekPeriodContaining(new Date(Date.UTC(2026, 5, 17)))).toEqual(PERIOD);
  });
  it("treats Monday as the start of its own week", () => {
    expect(weekPeriodContaining(new Date(Date.UTC(2026, 5, 15)))).toEqual(PERIOD);
  });
  it("treats Sunday as the end of the prior week", () => {
    // 2026-06-21 is a Sunday → still the week beginning 2026-06-15.
    expect(weekPeriodContaining(new Date(Date.UTC(2026, 5, 21)))).toEqual(PERIOD);
  });
});

describe("gating", () => {
  it("exposes enabled + settings from caps", () => {
    const { service } = makeService();
    expect(service.enabled).toBe(true);
    expect(service.settings()).toEqual({ enabled: true, maxNextBets: 5 });
  });

  it("generateReport throws when disabled", async () => {
    const { service } = makeService(DISABLED);
    await expect(service.generateReport("ws-1", PERIOD)).rejects.toBeInstanceOf(GrowthReportError);
  });

  it("runScheduledReport returns null when disabled (so a scheduler can call it unconditionally)", async () => {
    const { service, store } = makeService(DISABLED);
    expect(await service.runScheduledReport("ws-1")).toBeNull();
    expect(await store.list("ws-1")).toHaveLength(0);
  });
});

describe("generateReport", () => {
  it("synthesizes and persists a report keyed by workspace-week", async () => {
    const { service, store } = makeService();
    const rec = await service.generateReport("ws-1", PERIOD);
    expect(rec.id).toBe(reportId("ws-1", PERIOD.weekStart));
    expect(rec.report.workspaceId).toBe("ws-1");
    expect(rec.report.nextBets.length).toBeGreaterThan(0);
    expect(rec.generatedAt).toEqual(new Date(Date.UTC(2026, 5, 17)));
    expect(await store.get("ws-1", rec.id)).not.toBeNull();
  });

  it("re-generating the same week upserts (no duplicate)", async () => {
    const { service, store } = makeService();
    await service.generateReport("ws-1", PERIOD);
    await service.generateReport("ws-1", PERIOD);
    expect(await store.list("ws-1")).toHaveLength(1);
  });
});

describe("runScheduledReport", () => {
  it("generates the report for the current week, then is idempotent", async () => {
    const { service, store } = makeService();
    const first = await service.runScheduledReport("ws-1");
    expect(first).not.toBeNull();
    expect(first?.period).toEqual(PERIOD);

    const second = await service.runScheduledReport("ws-1");
    expect(second?.id).toBe(first?.id);
    expect(await store.list("ws-1")).toHaveLength(1);
  });
});

describe("read paths + scoping", () => {
  it("latest returns the newest week and list is newest-first", async () => {
    const { service } = makeService();
    await service.generateReport("ws-1", { weekStart: "2026-06-08", weekEnd: "2026-06-15" });
    await service.generateReport("ws-1", { weekStart: "2026-06-15", weekEnd: "2026-06-22" });
    const list = await service.listReports("ws-1");
    expect(list.map((r) => r.period.weekStart)).toEqual(["2026-06-15", "2026-06-08"]);
    expect((await service.latestReport("ws-1"))?.period.weekStart).toBe("2026-06-15");
  });

  it("does not leak another workspace's report (IDOR boundary)", async () => {
    const { service } = makeService();
    const rec = await service.generateReport("ws-1", PERIOD);
    expect(await service.getReport("ws-2", rec.id)).toBeNull();
    expect(await service.listReports("ws-2")).toHaveLength(0);
  });
});
