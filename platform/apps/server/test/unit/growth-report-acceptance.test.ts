import { describe, it, expect } from "vitest";
import { GrowthReportService } from "../../src/growth-report/service.js";
import { InMemoryGrowthReportStore } from "../../src/growth-report/store.js";
import { FakeGrowthDataSource } from "../../src/growth-report/source.js";
import { renderReport } from "../../src/growth-report/index.js";
import type { GrowthReportCaps } from "../../src/growth-report/caps.js";

/**
 * Acceptance test for issue #620:
 *   "A coherent weekly report is produced automatically with data-backed recommendations."
 *
 * End-to-end through the service over the deterministic, offline {@link FakeGrowthDataSource} (no external
 * calls, no DB) — exercising the same path a scheduler would. Asserts the report is coherent, that the
 * recommendations are data-backed, and that the whole thing is deterministic/reproducible.
 */

const ENABLED: GrowthReportCaps = { enabled: true, maxNextBets: 5 };

function makeService(clockMs = Date.UTC(2026, 5, 17)) {
  return new GrowthReportService({
    store: new InMemoryGrowthReportStore(),
    dataSource: new FakeGrowthDataSource(),
    caps: ENABLED,
    now: () => new Date(clockMs),
  });
}

describe("#620 acceptance — weekly auto-generated growth report", () => {
  it("produces a coherent report automatically with NO external calls (offline fake source)", async () => {
    const service = makeService();
    const rec = await service.runScheduledReport("acme");
    expect(rec).not.toBeNull();
    const report = rec!.report;

    // Coherent: a headline, a metric per tracked KPI, and at least one recommended next bet.
    expect(report.headline).toMatch(/^Week of \d{4}-\d{2}-\d{2}:/);
    expect(report.metrics.map((m) => m.key)).toEqual(["signups", "activations", "mrr", "churn_rate"]);
    expect(report.metrics.length).toBeGreaterThan(0);
    expect(report.nextBets.length).toBeGreaterThan(0);
  });

  it("every recommended next bet is data-backed (carries evidence + an impact score)", async () => {
    const report = (await makeService().runScheduledReport("acme"))!.report;
    for (const bet of report.nextBets) {
      expect(bet.action.length).toBeGreaterThan(0);
      expect(bet.rationale.length).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(bet.priority);
      expect(Number.isFinite(bet.impact)).toBe(true);
    }
    // The fake always includes a winning pricing experiment with positive lift → a scale recommendation.
    const scale = report.nextBets.find((b) => b.kind === "scale_winner");
    expect(scale).toBeDefined();
    expect(scale?.rationale).toMatch(/%/); // cites the measured lift
  });

  it("is deterministic: the same workspace-week reproduces an identical report", async () => {
    const a = (await makeService().runScheduledReport("acme"))!.report;
    const b = (await makeService().runScheduledReport("acme"))!.report;
    expect(b).toEqual(a);
  });

  it("different workspaces get different (but each internally consistent) data", async () => {
    const acme = (await makeService().runScheduledReport("acme"))!.report;
    const globex = (await makeService().runScheduledReport("globex"))!.report;
    expect(globex.metrics).not.toEqual(acme.metrics);
    // Each metric's delta is internally consistent with value - priorValue.
    for (const m of [...acme.metrics, ...globex.metrics]) {
      expect(m.delta).toBeCloseTo(m.value - m.priorValue, 6);
    }
  });

  it("renders to coherent human-readable text", async () => {
    const report = (await makeService().runScheduledReport("acme"))!.report;
    const lines = renderReport(report);
    const text = lines.join("\n");
    expect(text).toContain("Metrics:");
    expect(text).toContain("Recommended next bets:");
    expect(lines[0]).toBe(report.headline);
  });
});
