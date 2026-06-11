import { describe, it, expect } from "vitest";
import {
  classifySaturation,
  collectSaturation,
  eventLoopLagSeconds,
  DEFAULT_SATURATION_THRESHOLDS,
  type SaturationSample,
  type SaturationThresholds,
} from "../../src/observability/saturation.js";

const TH: SaturationThresholds = DEFAULT_SATURATION_THRESHOLDS;

function sample(over: Partial<SaturationSample> = {}): SaturationSample {
  return {
    queueDepth: 0,
    eventLoopLagSeconds: 0,
    pgPool: { total: 2, idle: 2, waiting: 0 },
    redisLatencySeconds: 0.001,
    ...over,
  };
}

describe("classifySaturation (the pure saturation verdict feeding alerts + the watchdog)", () => {
  it("is ok when every signal is under its warn threshold", () => {
    const s = classifySaturation(sample(), TH);
    expect(s.level).toBe("ok");
    expect(s.reasons).toEqual([]);
  });

  it("warns when one signal crosses its warn threshold", () => {
    const s = classifySaturation(
      sample({ eventLoopLagSeconds: TH.eventLoopLagWarnSeconds + 0.001 }),
      TH,
    );
    expect(s.level).toBe("warn");
    expect(s.reasons.some((r) => r.includes("event-loop"))).toBe(true);
  });

  it("escalates to critical and takes the worst signal as the overall level", () => {
    const s = classifySaturation(
      sample({
        eventLoopLagSeconds: TH.eventLoopLagWarnSeconds + 0.001, // warn
        queueDepth: TH.queueDepthCritical + 1, // critical
      }),
      TH,
    );
    expect(s.level).toBe("critical");
    expect(s.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("flags PG pool waiters", () => {
    const s = classifySaturation(
      sample({ pgPool: { total: 10, idle: 0, waiting: TH.pgPoolWaitingCritical } }),
      TH,
    );
    expect(s.level).toBe("critical");
    expect(s.reasons.some((r) => r.toLowerCase().includes("pool"))).toBe(true);
  });

  it("flags slow Redis when latency is present", () => {
    const s = classifySaturation(
      sample({ redisLatencySeconds: TH.redisLatencyCriticalSeconds + 0.01 }),
      TH,
    );
    expect(s.level).toBe("critical");
    expect(s.reasons.some((r) => r.toLowerCase().includes("redis"))).toBe(true);
  });

  it("skips the Redis signal entirely when latency is unavailable (null), never inventing a breach", () => {
    const s = classifySaturation(sample({ redisLatencySeconds: null }), TH);
    expect(s.level).toBe("ok");
    expect(s.reasons.some((r) => r.toLowerCase().includes("redis"))).toBe(false);
  });
});

describe("collectSaturation (the IO seam)", () => {
  it("assembles a sample from injected deps + the process event-loop monitor", async () => {
    const s = await collectSaturation({
      queueDepth: () => 7,
      pgPoolStats: () => ({ total: 10, idle: 3, waiting: 2 }),
      redisPing: async () => 0.004,
    });
    expect(s.queueDepth).toBe(7);
    expect(s.pgPool).toEqual({ total: 10, idle: 3, waiting: 2 });
    expect(s.redisLatencySeconds).toBe(0.004);
    expect(s.eventLoopLagSeconds).toBeGreaterThanOrEqual(0);
  });

  it("carries a null redis latency through (degraded, not a breach)", async () => {
    const s = await collectSaturation({
      queueDepth: () => 0,
      pgPoolStats: () => ({ total: 1, idle: 1, waiting: 0 }),
      redisPing: async () => null,
    });
    expect(s.redisLatencySeconds).toBeNull();
  });
});

describe("eventLoopLagSeconds", () => {
  it("returns a finite non-negative number", () => {
    const v = eventLoopLagSeconds();
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
  });
});
