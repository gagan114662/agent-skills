/**
 * Acceptance tests for the two resilience issues, phrased as their issue acceptance criteria:
 *
 *   #637: "a simulated transient failure is retried and succeeds without aborting the run."
 *   #638: "under induced rate limiting, runs slow down and complete rather than failing."
 */
import { describe, it, expect } from "vitest";
import { withRetry } from "../../src/resilience/execute.js";
import { RateLimitGate } from "../../src/resilience/limiter.js";
import type { RetryCaps } from "../../src/resilience/decide.js";
import type { RetryEvent, RetryObserver } from "../../src/resilience/observer.js";

class ManualClock {
  ms = 0;
  now = (): number => this.ms;
  sleep = async (d: number): Promise<void> => {
    this.ms += Math.max(0, d);
  };
}

class RecordingObserver implements RetryObserver {
  events: RetryEvent[] = [];
  onEvent(e: RetryEvent): void {
    this.events.push(e);
  }
}

const CAPS: RetryCaps & { enabled: boolean } = {
  enabled: true,
  maxAttempts: 5,
  baseMs: 200,
  factor: 2,
  maxDelayMs: 20_000,
  maxElapsedMs: 120_000,
  jitter: "none",
};

describe("#637 acceptance — transient failure is retried and succeeds without aborting", () => {
  it("a single 503 blip is absorbed and the operation completes", async () => {
    const clock = new ManualClock();
    const obs = new RecordingObserver();
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw { status: 503, message: "transient blip" };
        return { ok: true };
      },
      { operation: "external.call", caps: CAPS, now: clock.now, sleep: clock.sleep, rng: () => 0.5, observer: obs },
    );

    expect(result).toEqual({ ok: true }); // run was NOT aborted
    expect(attempts).toBe(2);
    // The retry is visible in the trace: exactly one retry event was emitted with the cause.
    const retries = obs.events.filter((e) => e.type === "retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ type: "retry", operation: "external.call", failure: { kind: "server", status: 503 } });
    expect(obs.events.at(-1)).toMatchObject({ type: "success", attempt: 2 });
  });
});

describe("#638 acceptance — under induced rate limiting, the run slows down and completes", () => {
  it("a provider that 429s twice (Retry-After 3s) paces through and finishes rather than failing", async () => {
    const clock = new ManualClock();
    const obs = new RecordingObserver();
    const gate = new RateLimitGate({ now: clock.now, sleep: clock.sleep });

    let calls = 0;
    const provider = async (): Promise<string> => {
      calls++;
      if (calls <= 2) throw { status: 429, headers: { "retry-after": "3" } };
      return "completed";
    };

    // Each attempt goes through the shared gate, so a 429 both waits out the provider (backoff respects
    // Retry-After) and arms the fleet-wide cooldown.
    const result = await withRetry((): Promise<string> => gate.run(provider), {
      operation: "provider.fetch",
      caps: CAPS,
      now: clock.now,
      sleep: clock.sleep,
      rng: () => 0,
      observer: obs,
    });

    expect(result).toBe("completed"); // the run completed rather than failing
    expect(calls).toBe(3);
    // It slowed down: two 3s Retry-After waits elapsed instead of an immediate abort.
    expect(clock.ms).toBe(6_000);
    expect(obs.events.filter((e) => e.type === "retry")).toHaveLength(2);
  });

  it("one agent tripping a 429 throttles every other agent sharing the gate", async () => {
    const clock = new ManualClock();
    const gate = new RateLimitGate({ now: clock.now, sleep: clock.sleep });

    // Agent A hits the rate limit and records a 10s cooldown.
    await expect(
      gate.run(async () => {
        throw { status: 429, headers: { "retry-after": "10" } };
      }),
    ).rejects.toBeDefined();

    // Agent B's unrelated, healthy request is forced to wait out A's cooldown — it slows down, but it
    // still runs and completes.
    let bRanAt = -1;
    const b = await gate.run(async () => {
      bRanAt = clock.ms;
      return "B-done";
    });
    expect(b).toBe("B-done");
    expect(bRanAt).toBe(10_000);
  });
});
