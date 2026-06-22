import { describe, it, expect } from "vitest";
import { withRetry } from "../../src/resilience/execute.js";
import type { RetryCaps } from "../../src/resilience/decide.js";
import type { RetryEvent, RetryObserver } from "../../src/resilience/observer.js";

/** A virtual clock: `sleep` advances time instantly so retry tests never actually wait. */
class ManualClock {
  ms = 0;
  now = (): number => this.ms;
  sleep = async (d: number): Promise<void> => {
    this.ms += Math.max(0, d);
  };
}

class RecordingObserver implements RetryObserver {
  events: RetryEvent[] = [];
  onEvent(event: RetryEvent): void {
    this.events.push(event);
  }
}

const CAPS: RetryCaps & { enabled: boolean } = {
  enabled: true,
  maxAttempts: 4,
  baseMs: 200,
  factor: 2,
  maxDelayMs: 20_000,
  maxElapsedMs: 60_000,
  jitter: "none",
};

function opts(clock: ManualClock, observer: RetryObserver, over: Partial<Parameters<typeof withRetry>[1]> = {}) {
  return {
    operation: "op",
    caps: CAPS,
    now: clock.now,
    sleep: clock.sleep,
    rng: () => 0,
    observer,
    ...over,
  };
}

describe("withRetry — happy path", () => {
  it("returns immediately on first success without sleeping", async () => {
    const clock = new ManualClock();
    const obs = new RecordingObserver();
    const result = await withRetry(async () => "ok", opts(clock, obs));
    expect(result).toBe("ok");
    expect(clock.ms).toBe(0);
    expect(obs.events.map((e) => e.type)).toEqual(["attempt", "success"]);
  });
});

describe("withRetry — transient retry (#637)", () => {
  it("retries a transient 503 and succeeds without aborting", async () => {
    const clock = new ManualClock();
    const obs = new RecordingObserver();
    let calls = 0;
    const result = await withRetry(async (attempt) => {
      calls++;
      expect(attempt).toBe(calls);
      if (calls === 1) throw { status: 503 };
      return "recovered";
    }, opts(clock, obs));

    expect(result).toBe("recovered");
    expect(calls).toBe(2);
    expect(clock.ms).toBe(200); // one base backoff
    const types = obs.events.map((e) => e.type);
    expect(types).toEqual(["attempt", "retry", "attempt", "success"]);
    const success = obs.events.at(-1);
    expect(success).toMatchObject({ type: "success", attempt: 2 });
  });

  it("waits out a 429 Retry-After across multiple attempts", async () => {
    const clock = new ManualClock();
    const obs = new RecordingObserver();
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls <= 2) throw { status: 429, headers: { "retry-after": "2" } };
      return "done";
    }, opts(clock, obs));

    expect(result).toBe("done");
    expect(calls).toBe(3);
    expect(clock.ms).toBe(4_000); // 2s + 2s Retry-After floors
  });
});

describe("withRetry — give up", () => {
  it("re-throws a permanent failure without retrying", async () => {
    const clock = new ManualClock();
    const obs = new RecordingObserver();
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw { status: 400, message: "bad request" };
      }, opts(clock, obs)),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(1);
    expect(obs.events.at(-1)).toMatchObject({ type: "give_up", reason: "permanent" });
  });

  it("re-throws the original error after exhausting the attempt budget", async () => {
    const clock = new ManualClock();
    const obs = new RecordingObserver();
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw { status: 503, marker: "always-down" };
      }, opts(clock, obs)),
    ).rejects.toMatchObject({ marker: "always-down" });
    expect(calls).toBe(4); // maxAttempts
    expect(obs.events.at(-1)).toMatchObject({ type: "give_up", reason: "exhausted_attempts" });
  });

  it("does not retry a non-idempotent operation", async () => {
    const clock = new ManualClock();
    const obs = new RecordingObserver();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw { status: 503 };
        },
        opts(clock, obs, { idempotent: false }),
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
    expect(obs.events.at(-1)).toMatchObject({ type: "give_up", reason: "not_idempotent" });
  });
});

describe("withRetry — disabled (default-off preserves today's behaviour)", () => {
  it("runs the operation exactly once when caps.enabled is false", async () => {
    const clock = new ManualClock();
    const obs = new RecordingObserver();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw { status: 503 };
        },
        opts(clock, obs, { caps: { ...CAPS, enabled: false } }),
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
    expect(obs.events.map((e) => e.type)).toEqual(["attempt"]);
  });
});
