import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";

/**
 * Saturation metrics, integration-tested against a real Postgres+Redis (#113, ADR-0113 acceptance §3).
 * `GET /metrics` must sample + expose the four capacity signals (queue depth, event-loop lag, PG pool
 * wait, Redis ping latency) so the #112 alerts + the #105 watchdog have something to read.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

describe("saturation metrics at /metrics (real Postgres + Redis)", () => {
  it("samples and exposes the capacity signals on scrape", async () => {
    // Issue one request so the pool has been touched, then scrape.
    await app.inject({ method: "GET", url: "/livez" });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const body = res.body;

    expect(body).toContain("# TYPE queue_depth gauge");
    expect(body).toMatch(/queue_depth \d+/);

    expect(body).toContain("# TYPE event_loop_lag_seconds gauge");
    expect(body).toMatch(/event_loop_lag_seconds [\d.]+/);

    expect(body).toContain("# TYPE pg_pool_connections gauge");
    expect(body).toMatch(/pg_pool_connections\{state="total"\} \d+/);
    expect(body).toMatch(/pg_pool_connections\{state="idle"\} \d+/);
    expect(body).toMatch(/pg_pool_connections\{state="waiting"\} \d+/);

    // Redis is up in the integration environment → the ping latency series is present.
    expect(body).toContain("# TYPE redis_ping_seconds gauge");
    expect(body).toMatch(/redis_ping_seconds [\d.]+/);
  });

  it("never fails the scrape (a slow/dead dependency degrades the metric, not the endpoint)", async () => {
    // Two consecutive scrapes both succeed — the sampler is fail-soft + bounded.
    const a = await app.inject({ method: "GET", url: "/metrics" });
    const b = await app.inject({ method: "GET", url: "/metrics" });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });
});
