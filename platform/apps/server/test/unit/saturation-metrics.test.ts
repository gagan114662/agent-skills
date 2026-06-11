import { describe, it, expect, beforeEach } from "vitest";
import { setSaturationSample, renderMetrics, resetMetrics } from "../../src/observability/metrics.js";

describe("saturation gauges (#113 — scrape-time capacity signals in the #19 registry)", () => {
  beforeEach(() => resetMetrics());

  it("renders queue depth, event-loop lag, pg pool, and redis latency when sampled", () => {
    setSaturationSample({
      queueDepth: 7,
      eventLoopLagSeconds: 0.012,
      pgPool: { total: 10, idle: 3, waiting: 2 },
      redisLatencySeconds: 0.004,
    });
    const out = renderMetrics();
    expect(out).toContain("# TYPE queue_depth gauge");
    expect(out).toMatch(/queue_depth 7/);
    expect(out).toContain("# TYPE event_loop_lag_seconds gauge");
    expect(out).toMatch(/event_loop_lag_seconds 0.012/);
    expect(out).toContain("# TYPE pg_pool_connections gauge");
    expect(out).toContain('pg_pool_connections{state="total"} 10');
    expect(out).toContain('pg_pool_connections{state="idle"} 3');
    expect(out).toContain('pg_pool_connections{state="waiting"} 2');
    expect(out).toContain('redis_ping_seconds 0.004');
  });

  it("omits the redis gauge when latency is unavailable (degraded Redis, not a zero reading)", () => {
    setSaturationSample({
      queueDepth: 0,
      eventLoopLagSeconds: 0,
      pgPool: { total: 1, idle: 1, waiting: 0 },
      redisLatencySeconds: null,
    });
    const out = renderMetrics();
    expect(out).toContain("# TYPE pg_pool_connections gauge");
    expect(out).not.toContain("redis_ping_seconds");
  });

  it("renders no saturation block before the first sample, and clears it on reset", () => {
    expect(renderMetrics()).not.toContain("queue_depth");
    setSaturationSample({
      queueDepth: 3,
      eventLoopLagSeconds: 0,
      pgPool: { total: 1, idle: 1, waiting: 0 },
      redisLatencySeconds: 0.001,
    });
    expect(renderMetrics()).toContain("queue_depth 3");
    resetMetrics();
    expect(renderMetrics()).not.toContain("queue_depth");
  });
});
