import { describe, it, expect } from "vitest";
import {
  isStale,
  revivalLimitReached,
  backoffElapsed,
  windowExpired,
} from "../../src/watchdog/guards.js";

/**
 * Pure bounded-restart guards for the Fleet Watchdog (#105), mirroring `autonomy/guards.ts` and
 * `venture/guards.ts`. No IO — `decide.ts` composes these.
 */
describe("watchdog guards", () => {
  describe("isStale", () => {
    it("is true once the no-progress age reaches the cutoff (boundary: >=)", () => {
      expect(isStale(5000, 5000)).toBe(true);
      expect(isStale(6000, 5000)).toBe(true);
    });
    it("is false before the cutoff", () => {
      expect(isStale(4999, 5000)).toBe(false);
    });
    it("is never stale when the cutoff is 0 (disabled — keeps today's behavior)", () => {
      expect(isStale(10_000, 0)).toBe(false);
    });
  });

  describe("revivalLimitReached", () => {
    it("is true once the window count reaches the max (boundary: >=)", () => {
      expect(revivalLimitReached(3, 3)).toBe(true);
      expect(revivalLimitReached(4, 3)).toBe(true);
    });
    it("is false below the max", () => {
      expect(revivalLimitReached(2, 3)).toBe(false);
    });
    it("treats a max of 0 as 'never revive' (escalate immediately)", () => {
      expect(revivalLimitReached(0, 0)).toBe(true);
    });
  });

  describe("backoffElapsed", () => {
    it("is true once enough time has passed since the last revival (boundary: >=)", () => {
      expect(backoffElapsed(30_000, 30_000)).toBe(true);
      expect(backoffElapsed(31_000, 30_000)).toBe(true);
    });
    it("is false while still inside the backoff window", () => {
      expect(backoffElapsed(29_999, 30_000)).toBe(false);
    });
    it("is true for a never-revived lineage (Infinity since last)", () => {
      expect(backoffElapsed(Number.POSITIVE_INFINITY, 30_000)).toBe(true);
    });
  });

  describe("windowExpired", () => {
    it("is true once the rolling window age reaches its length (boundary: >=)", () => {
      expect(windowExpired(3_600_000, 3_600_000)).toBe(true);
    });
    it("is false before the window elapses", () => {
      expect(windowExpired(3_599_999, 3_600_000)).toBe(false);
    });
  });
});
