import { describe, it, expect } from "vitest";
import {
  summarizeMetric,
  synthesizeWeeklyReport,
  formatPct,
  HIGH_PRIORITY_IMPACT,
} from "../../src/growth-report/synthesize.js";
import type { WeeklyGrowthData } from "../../src/growth-report/types.js";

/**
 * Unit tests of the pure synthesis core (#620): metric movement, win collection, and the data-backed
 * recommended next bets — all deterministic, no DB, no clock.
 */

const PERIOD = { weekStart: "2026-06-15", weekEnd: "2026-06-22" };

function data(over: Partial<WeeklyGrowthData> = {}): WeeklyGrowthData {
  return {
    workspaceId: "ws-1",
    period: PERIOD,
    metrics: [],
    experiments: [],
    ...over,
  };
}

describe("summarizeMetric", () => {
  it("computes delta, deltaPct, direction, and improvement for a higher-is-better metric", () => {
    const s = summarizeMetric({ key: "signups", label: "Signups", value: 118, priorValue: 100 });
    expect(s.delta).toBe(18);
    expect(s.deltaPct).toBeCloseTo(0.18, 6);
    expect(s.direction).toBe("up");
    expect(s.improved).toBe(true);
    expect(s.higherIsBetter).toBe(true); // default
  });

  it("treats a drop in a lower-is-better metric as an improvement", () => {
    const s = summarizeMetric({ key: "churn", label: "Churn", value: 3, priorValue: 5, higherIsBetter: false });
    expect(s.direction).toBe("down");
    expect(s.improved).toBe(true);
  });

  it("treats a rise in a lower-is-better metric as a regression", () => {
    const s = summarizeMetric({ key: "churn", label: "Churn", value: 7, priorValue: 5, higherIsBetter: false });
    expect(s.direction).toBe("up");
    expect(s.improved).toBe(false);
  });

  it("returns null deltaPct when the prior value is zero", () => {
    const s = summarizeMetric({ key: "x", label: "X", value: 10, priorValue: 0 });
    expect(s.deltaPct).toBeNull();
    expect(s.direction).toBe("up");
    expect(s.improved).toBe(true);
  });

  it("flat movement never counts as improved", () => {
    const s = summarizeMetric({ key: "x", label: "X", value: 50, priorValue: 50 });
    expect(s.direction).toBe("flat");
    expect(s.improved).toBe(false);
  });
});

describe("formatPct", () => {
  it("signs and rounds whole percents", () => {
    expect(formatPct(0.18)).toBe("+18%");
    expect(formatPct(-0.2)).toBe("−20%");
    expect(formatPct(0)).toBe("0%");
  });
  it("keeps one decimal for sub-1% magnitudes", () => {
    expect(formatPct(0.004)).toBe("+0.4%");
  });
});

describe("synthesizeWeeklyReport — wins", () => {
  it("surfaces improved metrics and winning experiments, ranked by magnitude", () => {
    const report = synthesizeWeeklyReport(
      data({
        metrics: [
          { key: "signups", label: "Signups", value: 110, priorValue: 100 }, // +10%
          { key: "mrr", label: "MRR", value: 100, priorValue: 100 }, // flat — not a win
        ],
        experiments: [
          { id: "e1", name: "Big win", hypothesis: "h", status: "win", metricKey: "signups", lift: 0.3 },
          { id: "e2", name: "Lost", hypothesis: "h", status: "loss", lift: -0.1 },
        ],
      }),
    );
    // experiment lift 0.30 > metric 0.10 → experiment ranks first
    expect(report.wins.map((w) => w.source)).toEqual(["experiment", "metric"]);
    expect(report.wins[0]?.headline).toContain("Big win");
    expect(report.wins.some((w) => w.headline.includes("MRR"))).toBe(false);
  });

  it("produces no wins when nothing improved", () => {
    const report = synthesizeWeeklyReport(
      data({ metrics: [{ key: "s", label: "S", value: 90, priorValue: 100 }] }),
    );
    expect(report.wins).toHaveLength(0);
  });
});

describe("synthesizeWeeklyReport — recommended next bets", () => {
  it("recommends scaling a winning experiment, with a data-backed rationale", () => {
    const report = synthesizeWeeklyReport(
      data({
        experiments: [{ id: "e1", name: "Pricing proof", hypothesis: "h", status: "win", metricKey: "signups", lift: 0.2 }],
      }),
    );
    const bet = report.nextBets.find((b) => b.kind === "scale_winner");
    expect(bet).toBeDefined();
    expect(bet?.action).toContain("Pricing proof");
    expect(bet?.rationale).toContain("+20%");
    expect(bet?.rationale).toContain("signups");
    expect(bet?.priority).toBe("high"); // 100 * 0.2 = 20 >= HIGH (15)
    expect(bet?.impact).toBe(100 * 0.2);
  });

  it("recommends investigating a regression, ranked by magnitude", () => {
    const report = synthesizeWeeklyReport(
      data({
        metrics: [{ key: "act", label: "Activations", value: 60, priorValue: 100 }], // -40%
      }),
    );
    const bet = report.nextBets.find((b) => b.kind === "fix_regression");
    expect(bet).toBeDefined();
    expect(bet?.action).toContain("Activations");
    expect(bet?.priority).toBe("high");
    expect(bet?.impact).toBeCloseTo(40, 6);
  });

  it("recommends extending an inconclusive/running experiment", () => {
    const report = synthesizeWeeklyReport(
      data({
        experiments: [
          { id: "e1", name: "Checklist", hypothesis: "h", status: "inconclusive", lift: 0.05 },
          { id: "e2", name: "Win-back", hypothesis: "h", status: "running" },
        ],
      }),
    );
    const extend = report.nextBets.filter((b) => b.kind === "extend_experiment");
    expect(extend).toHaveLength(2);
    expect(extend.map((b) => b.action)).toEqual(
      expect.arrayContaining([expect.stringContaining("Checklist"), expect.stringContaining("Win-back")]),
    );
  });

  it("does not recommend scaling a win that had zero/negative lift", () => {
    const report = synthesizeWeeklyReport(
      data({ experiments: [{ id: "e1", name: "Flat win", hypothesis: "h", status: "win", lift: 0 }] }),
    );
    expect(report.nextBets.some((b) => b.kind === "scale_winner")).toBe(false);
  });

  it("falls back to a keep_steady bet when nothing is actionable", () => {
    const report = synthesizeWeeklyReport(data());
    expect(report.nextBets).toHaveLength(1);
    expect(report.nextBets[0]?.kind).toBe("keep_steady");
    expect(report.nextBets[0]?.priority).toBe("low");
  });

  it("ranks bets by impact (desc) and caps to maxNextBets", () => {
    const report = synthesizeWeeklyReport(
      data({
        metrics: [
          { key: "a", label: "A", value: 50, priorValue: 100 }, // -50% regression, impact 50
          { key: "b", label: "B", value: 95, priorValue: 100 }, // -5% regression, impact 5
        ],
        experiments: [
          { id: "e1", name: "Win", hypothesis: "h", status: "win", lift: 0.1 }, // scale, impact 10
        ],
      }),
      { maxNextBets: 2 },
    );
    expect(report.nextBets).toHaveLength(2);
    // impacts: regression A=50, scale=10, regression B=5 → top two are A then scale
    expect(report.nextBets[0]?.action).toContain("A");
    expect(report.nextBets[0]?.impact).toBeGreaterThanOrEqual(HIGH_PRIORITY_IMPACT);
    expect(report.nextBets[1]?.kind).toBe("scale_winner");
  });
});

describe("synthesizeWeeklyReport — report shape", () => {
  it("carries the period, a non-empty headline, and normalized experiments", () => {
    const report = synthesizeWeeklyReport(
      data({
        metrics: [{ key: "s", label: "Signups", value: 130, priorValue: 100 }],
        experiments: [{ id: "e1", name: "Exp", hypothesis: "h", status: "win", lift: 0.2, metricKey: "s" }],
      }),
    );
    expect(report.period).toEqual(PERIOD);
    expect(report.headline).toContain("Week of 2026-06-15");
    expect(report.headline).toContain("Signups");
    expect(report.experiments).toHaveLength(1);
    expect(report.experiments[0]).toMatchObject({ id: "e1", status: "win", lift: 0.2 });
  });
});
