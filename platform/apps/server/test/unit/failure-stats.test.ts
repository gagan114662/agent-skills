import { describe, it, expect } from "vitest";
import { summarizeFailureClasses, type FailureStatsInput } from "../../src/runtime/failure-stats.js";

/** #394 — the failure histogram + rate that makes "~40% fail" measurable by class. */
describe("summarizeFailureClasses (#394 reliability instrumentation)", () => {
  const s = (status: FailureStatsInput["status"], exitCode: number | null = 0, result: string | null = null): FailureStatsInput => ({
    status,
    exitCode,
    result,
  });

  it("returns an all-zero report for an empty window (no divide-by-zero)", () => {
    const r = summarizeFailureClasses([]);
    expect(r).toEqual({ total: 0, succeeded: 0, failed: 0, failureRate: 0, byClass: {}, dominantClass: null });
  });

  it("counts a clean completion as succeeded, never failed", () => {
    const r = summarizeFailureClasses([s("completed", 0)]);
    expect(r.succeeded).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.failureRate).toBe(0);
    expect(r.dominantClass).toBeNull();
  });

  it("classifies a null-exit death as a spawn failure", () => {
    const r = summarizeFailureClasses([s("failed", null)]);
    expect(r.byClass.spawn).toBe(1);
    expect(r.dominantClass).toBe("spawn");
    expect(r.failed).toBe(1);
  });

  it("maps timeout + idle_reaped to the timeout class", () => {
    const r = summarizeFailureClasses([s("timeout", null), s("idle_reaped", null)]);
    expect(r.byClass.timeout).toBe(2);
    expect(r.failed).toBe(2);
  });

  it("computes the failure rate over the whole terminal window", () => {
    // 4 sessions: 2 completed, 1 spawn, 1 timeout → 50% failure.
    const r = summarizeFailureClasses([s("completed"), s("completed"), s("failed", null), s("timeout", null)]);
    expect(r.total).toBe(4);
    expect(r.succeeded).toBe(2);
    expect(r.failed).toBe(2);
    expect(r.failureRate).toBe(0.5);
  });

  it("picks the most frequent class as dominant", () => {
    const r = summarizeFailureClasses([s("failed", null), s("failed", null), s("timeout", null)]);
    expect(r.byClass.spawn).toBe(2);
    expect(r.byClass.timeout).toBe(1);
    expect(r.dominantClass).toBe("spawn");
  });

  it("breaks dominant-class ties by first-seen for determinism", () => {
    // one timeout then one spawn, both count 1 → first-seen (timeout) wins.
    const r = summarizeFailureClasses([s("timeout", null), s("failed", null)]);
    expect(r.dominantClass).toBe("timeout");
  });

  it("rounds the rate to 4 decimal places (1 failure in 3)", () => {
    const r = summarizeFailureClasses([s("failed", null), s("completed"), s("completed")]);
    expect(r.failureRate).toBe(0.3333);
  });
});
