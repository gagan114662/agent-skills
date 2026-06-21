import { describe, it, expect } from "vitest";
import { decideNextRun, isClaimable } from "../../src/scheduler/decide.js";
import type { BackoffPolicy } from "../../src/durable-workflow/types.js";

const policy: BackoffPolicy = { baseMs: 1_000, factor: 2, capMs: 8_000, maxAttempts: 5 };

describe("decideNextRun (#559 pure cursor-advance)", () => {
  it("on success schedules exactly one interval out and resets the failure counter", () => {
    const d = decideNextRun({
      status: "ok",
      nowMs: 10_000,
      intervalMs: 5_000,
      priorConsecutiveFailures: 3,
      policy,
    });
    expect(d).toEqual({ nextRunAtMs: 15_000, consecutiveFailures: 0 });
  });

  it("on first failure waits baseMs and increments failures to 1", () => {
    const d = decideNextRun({
      status: "error",
      nowMs: 10_000,
      intervalMs: 5_000,
      priorConsecutiveFailures: 0,
      policy,
    });
    // attempt index 0 → baseMs (1000).
    expect(d).toEqual({ nextRunAtMs: 11_000, consecutiveFailures: 1 });
  });

  it("backs off exponentially and is bounded by capMs so it can never hang", () => {
    const delays = [0, 1, 2, 3, 4, 5, 10].map((prior) => {
      const d = decideNextRun({
        status: "error",
        nowMs: 0,
        intervalMs: 5_000,
        priorConsecutiveFailures: prior,
        policy,
      });
      return d.nextRunAtMs;
    });
    // 1000, 2000, 4000, 8000 then capped at 8000 forever — always finite, never unbounded.
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000]);
  });

  it("treats a non-positive interval as fire-immediately on success (defensive)", () => {
    const d = decideNextRun({
      status: "ok",
      nowMs: 10_000,
      intervalMs: 0,
      priorConsecutiveFailures: 0,
      policy,
    });
    expect(d.nextRunAtMs).toBe(10_000);
  });
});

describe("isClaimable (#559 due + unleased predicate)", () => {
  it("is claimable when due and unleased", () => {
    expect(isClaimable({ nextRunAtMs: 1_000, lockedUntilMs: null }, 1_000)).toBe(true);
  });

  it("is not claimable before the cursor elapses", () => {
    expect(isClaimable({ nextRunAtMs: 2_000, lockedUntilMs: null }, 1_999)).toBe(false);
  });

  it("is not claimable while a live lease is held", () => {
    expect(isClaimable({ nextRunAtMs: 1_000, lockedUntilMs: 5_000 }, 2_000)).toBe(false);
  });

  it("is claimable again once the lease has expired (crashed-leader reclaim)", () => {
    expect(isClaimable({ nextRunAtMs: 1_000, lockedUntilMs: 5_000 }, 5_000)).toBe(true);
  });
});
