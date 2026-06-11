import { describe, it, expect } from "vitest";
import {
  percentile,
  summarize,
  rpsPerVcpu,
  evaluateBudgets,
  type PerfResult,
  type PerfBudget,
} from "../../src/perf/budgets.js";

describe("percentile + summarize (latency math)", () => {
  it("returns 0 for an empty sample", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(summarize([])).toEqual({ count: 0, p50Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 });
  });

  it("computes nearest-rank percentiles", () => {
    const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(s, 0.5)).toBe(50);
    expect(percentile(s, 0.9)).toBe(90);
    expect(percentile(s, 0.99)).toBe(100);
    expect(percentile(s, 1)).toBe(100);
  });

  it("is order-independent (sorts internally)", () => {
    expect(percentile([90, 10, 50, 30, 70], 0.5)).toBe(50);
  });

  it("summarizes count, p50, p99, max and mean", () => {
    const s = summarize([10, 20, 30, 40]);
    expect(s.count).toBe(4);
    expect(s.p50Ms).toBe(20);
    expect(s.maxMs).toBe(40);
    expect(s.meanMs).toBe(25);
  });
});

describe("rpsPerVcpu (the capacity-model anchor)", () => {
  it("divides throughput by the vCPU count", () => {
    expect(rpsPerVcpu(800, 4)).toBe(200);
  });
  it("guards a zero/negative vCPU count (returns the raw rps)", () => {
    expect(rpsPerVcpu(800, 0)).toBe(800);
  });
});

function result(over: Partial<PerfResult> = {}): PerfResult {
  return {
    name: "scn",
    requests: 1000,
    durationMs: 1000,
    rps: 1000,
    p50Ms: 2,
    p99Ms: 20,
    maxMs: 40,
    errors: 0,
    errorRate: 0,
    ...over,
  };
}

describe("evaluateBudgets (the CI perf gate)", () => {
  it("passes when every result is within its budget", () => {
    const results = [result({ name: "a" })];
    const budgets: PerfBudget[] = [{ name: "a", minRps: 200, maxP99Ms: 100, maxErrorRate: 0.01 }];
    expect(evaluateBudgets(results, budgets)).toEqual({ ok: true, violations: [] });
  });

  it("flags a throughput regression below the req/s floor", () => {
    const out = evaluateBudgets([result({ name: "a", rps: 50 })], [{ name: "a", minRps: 200 }]);
    expect(out.ok).toBe(false);
    expect(out.violations).toEqual([{ name: "a", metric: "rps", budget: 200, actual: 50 }]);
  });

  it("flags a p99 latency regression above the ceiling", () => {
    const out = evaluateBudgets([result({ name: "a", p99Ms: 500 })], [{ name: "a", maxP99Ms: 100 }]);
    expect(out.ok).toBe(false);
    expect(out.violations).toEqual([{ name: "a", metric: "p99Ms", budget: 100, actual: 500 }]);
  });

  it("flags a p50 latency regression above the ceiling", () => {
    const out = evaluateBudgets([result({ name: "a", p50Ms: 50 })], [{ name: "a", maxP50Ms: 10 }]);
    expect(out.ok).toBe(false);
    expect(out.violations).toEqual([{ name: "a", metric: "p50Ms", budget: 10, actual: 50 }]);
  });

  it("flags an error-rate regression above the ceiling", () => {
    const out = evaluateBudgets(
      [result({ name: "a", errors: 100, errorRate: 0.1 })],
      [{ name: "a", maxErrorRate: 0.01 }],
    );
    expect(out.ok).toBe(false);
    expect(out.violations).toEqual([{ name: "a", metric: "errorRate", budget: 0.01, actual: 0.1 }]);
  });

  it("reports every violated metric for a scenario at once", () => {
    const out = evaluateBudgets(
      [result({ name: "a", rps: 10, p99Ms: 999 })],
      [{ name: "a", minRps: 200, maxP99Ms: 100 }],
    );
    expect(out.ok).toBe(false);
    expect(out.violations.map((v) => v.metric).sort()).toEqual(["p99Ms", "rps"]);
  });

  it("treats a budget with no matching result as a failure (the scenario never ran)", () => {
    const out = evaluateBudgets([], [{ name: "missing", minRps: 200 }]);
    expect(out.ok).toBe(false);
    expect(out.violations[0]).toMatchObject({ name: "missing", metric: "rps" });
  });

  it("ignores results that have no budget (only declared budgets gate)", () => {
    const out = evaluateBudgets([result({ name: "ungated", rps: 1 })], []);
    expect(out).toEqual({ ok: true, violations: [] });
  });
});
