import { describe, it, expect } from "vitest";
import {
  spendStatus,
  decideSpend,
  validateRaise,
  applyReserve,
  applySettle,
  applyRelease,
  applyLowerCap,
  applyRaiseCap,
  type SpendState,
} from "../../src/budget/governor.js";

const state = (capCents: number, committedCents: number, projectedCents: number): SpendState => ({
  capCents,
  committedCents,
  projectedCents,
});

describe("budget governor — spendStatus", () => {
  it("reports headroom, utilization and not-halted below the cap", () => {
    const s = spendStatus(state(10_000, 3_000, 1_000), 8_000);
    expect(s.totalCents).toBe(4_000);
    expect(s.availableCents).toBe(6_000);
    expect(s.utilizationBps).toBe(4_000);
    expect(s.halted).toBe(false);
    expect(s.alerting).toBe(false);
  });

  it("alerts once utilization reaches the threshold", () => {
    const s = spendStatus(state(10_000, 8_000, 500), 8_000);
    expect(s.utilizationBps).toBe(8_500);
    expect(s.alerting).toBe(true);
    expect(s.halted).toBe(false);
  });

  it("is halted (and fully utilized) once committed+projected reach the cap", () => {
    const s = spendStatus(state(10_000, 7_000, 3_000), 8_000);
    expect(s.availableCents).toBe(0);
    expect(s.utilizationBps).toBe(10_000);
    expect(s.halted).toBe(true);
  });

  it("a non-positive cap reads as fully utilized and halted (fail-closed)", () => {
    const s = spendStatus(state(0, 0, 0), 8_000);
    expect(s.utilizationBps).toBe(10_000);
    expect(s.halted).toBe(true);
  });

  it("normalizes a poisoned negative committed counter to 0 (cannot manufacture headroom)", () => {
    const s = spendStatus(state(10_000, -5_000, 0), 8_000);
    expect(s.committedCents).toBe(0);
    expect(s.availableCents).toBe(10_000);
  });

  it("normalizes a poisoned non-finite committed counter up to the cap (blocks)", () => {
    const s = spendStatus(state(10_000, Number.NaN, 0), 8_000);
    expect(s.committedCents).toBe(10_000);
    expect(s.availableCents).toBe(0);
    expect(s.halted).toBe(true);
  });
});

describe("budget governor — decideSpend", () => {
  it("allows a spend that fits inside the remaining headroom", () => {
    const d = decideSpend(state(10_000, 4_000, 1_000), 5_000);
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
    expect(d.availableCents).toBe(5_000);
    expect(d.overByCents).toBe(0);
  });

  it("halts a spend that would exceed the cap and routes to a cap-raise approval", () => {
    const d = decideSpend(state(10_000, 8_000, 1_000), 5_000);
    expect(d.allowed).toBe(false);
    expect(d.requiresApproval).toBe(true);
    expect(d.availableCents).toBe(1_000);
    expect(d.overByCents).toBe(4_000);
  });

  it("treats a non-positive spend as an allowed no-op", () => {
    const d = decideSpend(state(10_000, 9_999, 0), 0);
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  it("never auto-spends on an indeterminate amount (requires approval)", () => {
    const d = decideSpend(state(10_000, 0, 0), Number.POSITIVE_INFINITY);
    expect(d.allowed).toBe(false);
    expect(d.requiresApproval).toBe(true);
  });

  it("a spend exactly equal to the headroom is allowed; one cent more halts", () => {
    expect(decideSpend(state(10_000, 0, 0), 10_000).allowed).toBe(true);
    expect(decideSpend(state(10_000, 0, 0), 10_001).allowed).toBe(false);
  });
});

describe("budget governor — validateRaise", () => {
  it("accepts a raise strictly above the current cap", () => {
    expect(validateRaise(10_000, 20_000).ok).toBe(true);
  });

  it("rejects a target equal to or below the current cap (not a raise)", () => {
    expect(validateRaise(10_000, 10_000).ok).toBe(false);
    expect(validateRaise(10_000, 5_000).ok).toBe(false);
  });

  it("rejects a non-finite or negative target (fail-closed)", () => {
    expect(validateRaise(10_000, Number.NaN).ok).toBe(false);
    expect(validateRaise(10_000, -1).ok).toBe(false);
  });
});

describe("budget governor — pure state transitions", () => {
  it("reserve adds to projected without touching committed", () => {
    expect(applyReserve(state(10_000, 1_000, 500), 2_000)).toEqual(
      state(10_000, 1_000, 2_500),
    );
  });

  it("settle moves a reservation from projected to committed (clamped at 0)", () => {
    // reserved 2000, actual came in at 1800
    expect(applySettle(state(10_000, 1_000, 2_000), 2_000, 1_800)).toEqual(
      state(10_000, 2_800, 0),
    );
  });

  it("release frees a reservation, never driving projected negative", () => {
    expect(applyRelease(state(10_000, 0, 1_000), 5_000)).toEqual(state(10_000, 0, 0));
  });

  it("lowerCap tightens the ceiling immediately (no approval needed)", () => {
    expect(applyLowerCap(state(10_000, 0, 0), 4_000).capCents).toBe(4_000);
  });

  it("raiseCap sets the new (approved) ceiling", () => {
    expect(applyRaiseCap(state(10_000, 0, 0), 25_000).capCents).toBe(25_000);
  });
});
