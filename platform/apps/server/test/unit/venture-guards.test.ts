import { describe, it, expect } from "vitest";
import {
  scorecardExpired,
  hasNovelAngle,
  maxIterationsReached,
} from "../../src/venture/guards.js";

describe("venture guards (pure)", () => {
  it("scorecardExpired is true only once now reaches/passes expiry", () => {
    const expiresAt = new Date("2026-01-01T00:00:00Z");
    expect(scorecardExpired(expiresAt, new Date("2025-12-31T23:59:59Z"))).toBe(false);
    expect(scorecardExpired(expiresAt, new Date("2026-01-01T00:00:00Z"))).toBe(true);
    expect(scorecardExpired(expiresAt, new Date("2026-02-01T00:00:00Z"))).toBe(true);
  });

  it("hasNovelAngle is true iff some proposed angle was not already tried", () => {
    expect(hasNovelAngle(["a", "b"], ["a"])).toBe(true);
    expect(hasNovelAngle(["a"], ["a", "b"])).toBe(false);
    expect(hasNovelAngle([], [])).toBe(false); // nothing to pursue is not novel
  });

  it("maxIterationsReached compares the 1-based iteration against the cap", () => {
    expect(maxIterationsReached(2, 3)).toBe(false);
    expect(maxIterationsReached(3, 3)).toBe(true);
    expect(maxIterationsReached(4, 3)).toBe(true);
  });
});
