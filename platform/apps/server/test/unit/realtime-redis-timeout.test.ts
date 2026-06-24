import { describe, expect, it, beforeEach } from "vitest";
import {
  RealtimeRedisTimeoutError,
  withRealtimeRedisTimeout,
} from "../../src/realtime/bus.js";
import {
  recordRedisPubSubTimeout,
  renderMetrics,
  resetMetrics,
} from "../../src/observability/metrics.js";

describe("realtime Redis pub/sub timeouts (#995)", () => {
  beforeEach(() => resetMetrics());

  it("bounds a hung Redis command instead of waiting forever", async () => {
    await expect(
      withRealtimeRedisTimeout("publish", new Promise<never>(() => undefined), 1),
    ).rejects.toBeInstanceOf(RealtimeRedisTimeoutError);
  });

  it("emits a bounded metric for pub/sub timeouts", () => {
    recordRedisPubSubTimeout("publish");
    recordRedisPubSubTimeout("publish");
    recordRedisPubSubTimeout("psubscribe");

    const out = renderMetrics();
    expect(out).toContain('redis_pubsub_timeouts_total{operation="publish"} 2');
    expect(out).toContain('redis_pubsub_timeouts_total{operation="psubscribe"} 1');
  });
});
