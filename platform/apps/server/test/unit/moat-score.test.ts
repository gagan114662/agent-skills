import { describe, it, expect } from "vitest";
import {
  MOAT_DIMENSIONS,
  dimensionSubscore,
  defaultMoatWeights,
  scoreMoat,
  assessAccrualWindow,
  type MoatDimension,
  type MoatWeights,
} from "../../src/moat/score.js";

const day = 24 * 60 * 60 * 1000;

/** Weights with the same value in every dimension. */
function uniformWeights(v: number): MoatWeights {
  return Object.fromEntries(MOAT_DIMENSIONS.map((d) => [d, v])) as MoatWeights;
}

function accrual(dimension: MoatDimension, magnitude: number) {
  return { dimension, magnitude };
}

describe("moat dimensions", () => {
  it("has the four moat dimensions from the premortem", () => {
    expect(MOAT_DIMENSIONS).toContain("proprietaryData");
    expect(MOAT_DIMENSIONS).toContain("switchingCosts");
    expect(MOAT_DIMENSIONS).toContain("distributionLockIn");
    expect(MOAT_DIMENSIONS).toContain("accumulatedEvals");
    expect(MOAT_DIMENSIONS).toHaveLength(4);
  });
});

describe("dimensionSubscore (saturating, diminishing returns)", () => {
  it("is 0 for no accrual", () => {
    expect(dimensionSubscore(0)).toBe(0);
  });

  it("is bounded in [0,10) and monotonic increasing", () => {
    const a = dimensionSubscore(5);
    const b = dimensionSubscore(50);
    const c = dimensionSubscore(500);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c).toBeLessThan(10);
  });

  it("has diminishing returns — the first units matter more than later ones", () => {
    const firstDelta = dimensionSubscore(10) - dimensionSubscore(0);
    const laterDelta = dimensionSubscore(110) - dimensionSubscore(100);
    expect(firstDelta).toBeGreaterThan(laterDelta);
  });
});

describe("scoreMoat", () => {
  it("scores an empty ledger as 0 on every dimension and 0 aggregate", () => {
    const s = scoreMoat([], defaultMoatWeights());
    expect(s.score).toBe(0);
    for (const d of MOAT_DIMENSIONS) expect(s.dimensions[d]).toBe(0);
  });

  it("sums magnitudes within a dimension before scoring it", () => {
    const split = scoreMoat(
      [accrual("proprietaryData", 5), accrual("proprietaryData", 5)],
      defaultMoatWeights(),
    );
    const single = scoreMoat([accrual("proprietaryData", 10)], defaultMoatWeights());
    expect(split.dimensions.proprietaryData).toBeCloseTo(single.dimensions.proprietaryData, 10);
  });

  it("keeps the aggregate within 0–100", () => {
    const s = scoreMoat(
      MOAT_DIMENSIONS.map((d) => accrual(d, 1000)),
      defaultMoatWeights(),
    );
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });

  it("rewards breadth — accrual spread across dimensions beats the same magnitude in one", () => {
    const broad = scoreMoat(
      MOAT_DIMENSIONS.map((d) => accrual(d, 25)),
      defaultMoatWeights(),
    );
    const narrow = scoreMoat([accrual("proprietaryData", 100)], defaultMoatWeights());
    expect(broad.score).toBeGreaterThan(narrow.score);
  });

  it("applies per-dimension weights", () => {
    const accruals = [accrual("proprietaryData", 50), accrual("switchingCosts", 50)];
    const onlyData: MoatWeights = {
      ...uniformWeights(0),
      proprietaryData: 1,
    };
    const s = scoreMoat(accruals, onlyData);
    // Only proprietaryData is weighted, so the aggregate equals that dimension's subscore × 10.
    expect(s.score).toBeCloseTo(s.dimensions.proprietaryData * 10, 6);
  });

  it("scores 0 when all weights are 0 (no division by zero)", () => {
    const s = scoreMoat([accrual("proprietaryData", 100)], uniformWeights(0));
    expect(s.score).toBe(0);
  });

  it("ignores negative weights (clamped to 0)", () => {
    const accruals = [accrual("proprietaryData", 50), accrual("switchingCosts", 50)];
    const negative: MoatWeights = { ...uniformWeights(1), switchingCosts: -5 };
    const clamped: MoatWeights = { ...uniformWeights(1), switchingCosts: 0 };
    expect(scoreMoat(accruals, negative).score).toBeCloseTo(scoreMoat(accruals, clamped).score, 6);
  });
});

describe("assessAccrualWindow (stagnation)", () => {
  const nowMs = 100 * day;

  it("flags a venture with no accruals at all as stagnant", () => {
    const a = assessAccrualWindow({ entries: [], nowMs, windowMs: 30 * day });
    expect(a.stagnant).toBe(true);
    expect(a.accrualsInWindow).toBe(0);
    expect(a.lastAccrualAtMs).toBeNull();
  });

  it("is not stagnant when an accrual lands inside the window", () => {
    const a = assessAccrualWindow({
      entries: [{ createdAtMs: nowMs - 5 * day }],
      nowMs,
      windowMs: 30 * day,
    });
    expect(a.stagnant).toBe(false);
    expect(a.accrualsInWindow).toBe(1);
    expect(a.lastAccrualAtMs).toBe(nowMs - 5 * day);
  });

  it("flags as stagnant when the only accruals are older than the window", () => {
    const a = assessAccrualWindow({
      entries: [{ createdAtMs: nowMs - 40 * day }, { createdAtMs: nowMs - 60 * day }],
      nowMs,
      windowMs: 30 * day,
    });
    expect(a.stagnant).toBe(true);
    expect(a.accrualsInWindow).toBe(0);
    // lastAccrualAtMs still reports the most recent accrual even when it's outside the window.
    expect(a.lastAccrualAtMs).toBe(nowMs - 40 * day);
  });

  it("treats an accrual exactly at the window edge as outside (strict)", () => {
    const a = assessAccrualWindow({
      entries: [{ createdAtMs: nowMs - 30 * day }],
      nowMs,
      windowMs: 30 * day,
    });
    expect(a.stagnant).toBe(true);
    expect(a.accrualsInWindow).toBe(0);
  });
});
