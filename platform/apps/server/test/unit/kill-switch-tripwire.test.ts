import { describe, it, expect } from "vitest";
import {
  evaluateTripwires,
  summarizeBreaches,
  type GuardMetrics,
  type TripwireThresholds,
} from "../../src/kill-switch/tripwire.js";

const HEALTHY: GuardMetrics = { spendPerHourCents: 1_000, errorRateBps: 100, bounceRateBps: 200 };

const THRESHOLDS: TripwireThresholds = {
  maxSpendPerHourCents: 10_000, // $100/hr
  maxErrorRateBps: 2_000, // 20%
  maxBounceRateBps: 3_000, // 30%
};

describe("evaluateTripwires", () => {
  it("does not breach when every metric is within its ceiling", () => {
    const ev = evaluateTripwires(HEALTHY, THRESHOLDS);
    expect(ev.breached).toBe(false);
    expect(ev.breaches).toEqual([]);
  });

  it("breaches on a spend spike (the canonical #592 trigger)", () => {
    const ev = evaluateTripwires({ ...HEALTHY, spendPerHourCents: 50_000 }, THRESHOLDS);
    expect(ev.breached).toBe(true);
    expect(ev.breaches).toHaveLength(1);
    expect(ev.breaches[0]?.metric).toBe("spend_per_hour");
    expect(ev.breaches[0]?.observed).toBe(50_000);
    expect(ev.breaches[0]?.threshold).toBe(10_000);
  });

  it("breaches when a reading exactly reaches the ceiling (>=)", () => {
    const ev = evaluateTripwires({ ...HEALTHY, errorRateBps: 2_000 }, THRESHOLDS);
    expect(ev.breached).toBe(true);
    expect(ev.breaches[0]?.metric).toBe("error_rate");
  });

  it("reports EVERY breached metric, not just the first", () => {
    const ev = evaluateTripwires(
      { spendPerHourCents: 99_999, errorRateBps: 9_000, bounceRateBps: 9_000 },
      THRESHOLDS,
    );
    expect(ev.breached).toBe(true);
    expect(ev.breaches.map((b) => b.metric).sort()).toEqual([
      "bounce_rate",
      "error_rate",
      "spend_per_hour",
    ]);
  });

  it("leaves a metric UNMONITORED when its ceiling is null / non-positive", () => {
    const onlySpend: TripwireThresholds = {
      maxSpendPerHourCents: 10_000,
      maxErrorRateBps: null,
      maxBounceRateBps: 0, // non-positive ⇒ unmonitored
    };
    const ev = evaluateTripwires(
      { spendPerHourCents: 5_000, errorRateBps: 9_999, bounceRateBps: 9_999 },
      onlySpend,
    );
    expect(ev.breached).toBe(false);
  });

  it("an empty threshold set is an armed-but-inert switch (never trips)", () => {
    const ev = evaluateTripwires(
      { spendPerHourCents: 9_999_999, errorRateBps: 10_000, bounceRateBps: 10_000 },
      { maxSpendPerHourCents: null, maxErrorRateBps: null, maxBounceRateBps: null },
    );
    expect(ev.breached).toBe(false);
  });

  describe("#200 fail-closed normalization", () => {
    it("trips on an INDETERMINATE reading for a monitored metric", () => {
      const ev = evaluateTripwires({ ...HEALTHY, spendPerHourCents: NaN }, THRESHOLDS);
      expect(ev.breached).toBe(true);
      expect(ev.breaches[0]?.metric).toBe("spend_per_hour");
      expect(ev.breaches[0]?.observed).toBeNull();
    });

    it("trips on +Infinity for a monitored metric", () => {
      const ev = evaluateTripwires({ ...HEALTHY, errorRateBps: Number.POSITIVE_INFINITY }, THRESHOLDS);
      expect(ev.breached).toBe(true);
      expect(ev.breaches[0]?.observed).toBeNull();
    });

    it("clamps a negative reading to 0 (a sensor cannot hide a problem with a negative)", () => {
      const ev = evaluateTripwires({ ...HEALTHY, bounceRateBps: -5_000 }, THRESHOLDS);
      expect(ev.breached).toBe(false);
    });

    it("does NOT trip an unmonitored metric even when its reading is indeterminate", () => {
      const ev = evaluateTripwires(
        { spendPerHourCents: NaN, errorRateBps: 100, bounceRateBps: 100 },
        { maxSpendPerHourCents: null, maxErrorRateBps: 2_000, maxBounceRateBps: 3_000 },
      );
      expect(ev.breached).toBe(false);
    });
  });

  it("summarizeBreaches renders a readable, joined reason", () => {
    const ev = evaluateTripwires({ ...HEALTHY, spendPerHourCents: 50_000 }, THRESHOLDS);
    const summary = summarizeBreaches(ev.breaches);
    expect(summary).toContain("spend_per_hour");
    expect(summarizeBreaches([])).toBe("no tripwires breached");
  });
});
