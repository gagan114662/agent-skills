import { describe, it, expect } from "vitest";
import {
  DEFAULT_LOOP_GUARD_MAX,
  budgetExhausted,
  tickLimitReached,
  loopGuardTripped,
} from "../../src/autonomy/guards.js";

describe("autonomy guards (#17)", () => {
  describe("budgetExhausted (cost guard)", () => {
    it("is false while under budget", () => {
      expect(budgetExhausted(0, 100)).toBe(false);
      expect(budgetExhausted(99, 100)).toBe(false);
    });
    it("trips at and beyond the budget", () => {
      expect(budgetExhausted(100, 100)).toBe(true);
      expect(budgetExhausted(101, 100)).toBe(true);
    });
    it("a zero budget is exhausted immediately", () => {
      expect(budgetExhausted(0, 0)).toBe(true);
    });
  });

  describe("tickLimitReached (rate guard)", () => {
    it("is false while under the per-tick cap", () => {
      expect(tickLimitReached(0, 5)).toBe(false);
      expect(tickLimitReached(4, 5)).toBe(false);
    });
    it("trips at the cap", () => {
      expect(tickLimitReached(5, 5)).toBe(true);
      expect(tickLimitReached(6, 5)).toBe(true);
    });
  });

  describe("loopGuardTripped", () => {
    it("uses the default ceiling when no max is given", () => {
      expect(loopGuardTripped(DEFAULT_LOOP_GUARD_MAX - 1)).toBe(false);
      expect(loopGuardTripped(DEFAULT_LOOP_GUARD_MAX)).toBe(true);
    });
    it("honours a custom ceiling", () => {
      expect(loopGuardTripped(2, 3)).toBe(false);
      expect(loopGuardTripped(3, 3)).toBe(true);
    });
  });
});
