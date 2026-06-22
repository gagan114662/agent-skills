import { describe, it, expect } from "vitest";
import { computeBackoff, type BackoffCaps } from "../../src/resilience/backoff.js";

const CAPS: BackoffCaps = { baseMs: 200, factor: 2, maxDelayMs: 20_000, jitter: "none" };
const FULL: BackoffCaps = { ...CAPS, jitter: "full" };

describe("computeBackoff — exponential schedule (no jitter)", () => {
  it("doubles each attempt from the base", () => {
    expect(computeBackoff(1, CAPS, () => 0)).toBe(200);
    expect(computeBackoff(2, CAPS, () => 0)).toBe(400);
    expect(computeBackoff(3, CAPS, () => 0)).toBe(800);
    expect(computeBackoff(4, CAPS, () => 0)).toBe(1_600);
  });

  it("caps the exponential term at maxDelayMs", () => {
    expect(computeBackoff(20, CAPS, () => 0)).toBe(20_000);
  });

  it("never produces Infinity for a huge attempt count", () => {
    expect(Number.isFinite(computeBackoff(2_000, CAPS, () => 0))).toBe(true);
  });
});

describe("computeBackoff — full jitter", () => {
  it("scales the capped delay by rng in [0, capped]", () => {
    // attempt 3 capped = 800ms; rng 0.5 ⇒ 400ms
    expect(computeBackoff(3, FULL, () => 0.5)).toBe(400);
    expect(computeBackoff(3, FULL, () => 0)).toBe(0);
    expect(computeBackoff(3, FULL, () => 0.999999)).toBe(800);
  });

  it("clamps a misbehaving rng into [0,1]", () => {
    expect(computeBackoff(2, FULL, () => 5)).toBe(400); // treated as 1.0
    expect(computeBackoff(2, FULL, () => -3)).toBe(0); // treated as 0.0
  });
});

describe("computeBackoff — Retry-After floor (#638)", () => {
  it("never retries sooner than the server asked, even with tiny jitter", () => {
    expect(computeBackoff(1, FULL, () => 0, 5_000)).toBe(5_000);
  });

  it("uses the jittered delay when it already exceeds Retry-After", () => {
    // attempt 5 capped = 3200; jitter 1.0 ⇒ 3200 > 1000 floor
    expect(computeBackoff(5, FULL, () => 0.999999, 1_000)).toBe(3_200);
  });

  it("honours a Retry-After larger than the per-attempt cap", () => {
    expect(computeBackoff(1, CAPS, () => 0, 60_000)).toBe(60_000);
  });
});
