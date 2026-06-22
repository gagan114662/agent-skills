import { describe, it, expect } from "vitest";
import { RateLimitGate } from "../../src/resilience/limiter.js";

/** Virtual clock: `sleep` advances time instantly so pacing tests never actually wait. */
class ManualClock {
  ms = 0;
  now = (): number => this.ms;
  sleep = async (d: number): Promise<void> => {
    this.ms += Math.max(0, d);
  };
}

describe("RateLimitGate — steady-state pacing (#638)", () => {
  it("spaces sequential request starts by minIntervalMs", async () => {
    const clock = new ManualClock();
    const gate = new RateLimitGate({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });
    const starts: number[] = [];
    await gate.run(async () => void starts.push(clock.ms));
    await gate.run(async () => void starts.push(clock.ms));
    await gate.run(async () => void starts.push(clock.ms));
    expect(starts).toEqual([0, 100, 200]);
  });

  it("the first request starts immediately (no warm-up delay)", async () => {
    const clock = new ManualClock();
    clock.ms = 5_000;
    const gate = new RateLimitGate({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });
    await gate.run(async () => {});
    expect(clock.ms).toBe(5_000);
  });

  it("paces a concurrent burst (all complete, total time = sum of gaps)", async () => {
    const clock = new ManualClock();
    const gate = new RateLimitGate({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });
    const results = await Promise.all([1, 2, 3, 4].map((n) => gate.run(async () => n)));
    expect(results).toEqual([1, 2, 3, 4]);
    expect(clock.ms).toBe(300); // 3 gaps of 100ms
  });
});

describe("RateLimitGate — Retry-After cooldown throttles the fleet (#638)", () => {
  it("a 429 with Retry-After makes the next request wait it out instead of failing", async () => {
    const clock = new ManualClock();
    const gate = new RateLimitGate({ now: clock.now, sleep: clock.sleep });

    // First request trips the limit.
    await expect(
      gate.run(async () => {
        throw { status: 429, headers: { "retry-after": "5" } };
      }),
    ).rejects.toBeDefined();
    expect(gate.cooldownRemainingMs()).toBe(5_000);

    // The next request — even a healthy one — is held until the cooldown elapses.
    let ranAt = -1;
    await gate.run(async () => {
      ranAt = clock.ms;
      return "ok";
    });
    expect(ranAt).toBe(5_000);
    expect(gate.isCoolingDown()).toBe(false);
  });

  it("noteRateLimited only ever pushes the cooldown later (monotonic)", () => {
    const clock = new ManualClock();
    const gate = new RateLimitGate({ now: clock.now, sleep: clock.sleep });
    gate.noteRateLimited(5_000);
    gate.noteRateLimited(1_000); // shorter — must not shorten the existing cooldown
    expect(gate.cooldownRemainingMs()).toBe(5_000);
    gate.noteRateLimited(8_000);
    expect(gate.cooldownRemainingMs()).toBe(8_000);
  });

  it("ignores non-positive Retry-After and non-rate-limit errors", async () => {
    const clock = new ManualClock();
    const gate = new RateLimitGate({ now: clock.now, sleep: clock.sleep });
    await expect(
      gate.run(async () => {
        throw { status: 500 }; // server error, not a rate limit
      }),
    ).rejects.toBeDefined();
    expect(gate.isCoolingDown()).toBe(false);
  });
});
