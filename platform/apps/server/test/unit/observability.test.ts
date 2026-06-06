import { describe, it, expect, vi } from "vitest";

// Hermetic: mock the dependency pings so these tests never touch a real DB/Redis.
// Real readiness against live deps is covered in test/integration/observability.test.ts.
vi.mock("../../src/db/index.js", () => ({ pingDb: vi.fn().mockResolvedValue(true), closeDb: vi.fn() }));
vi.mock("../../src/redis/index.js", () => ({
  pingRedis: vi.fn().mockResolvedValue(true),
  closeRedis: vi.fn(),
}));

const { buildApp } = await import("../../src/app.js");

describe("liveness probe", () => {
  it("GET /livez always returns 200 ok", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/livez" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("correlation id", () => {
  it("generates an x-request-id when the client sends none", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/livez" });
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(typeof res.headers["x-request-id"]).toBe("string");
    await app.close();
  });

  it("echoes the client-supplied x-request-id (end-to-end traceability)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/livez",
      headers: { "x-request-id": "trace-abc-123" },
    });
    expect(res.headers["x-request-id"]).toBe("trace-abc-123");
    await app.close();
  });
});

describe("metrics endpoint", () => {
  it("GET /metrics returns Prometheus text exposition", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("# TYPE http_requests_total counter");
    expect(res.body).toContain("http_requests_total");
    await app.close();
  });

  it("counts requests by method, route template, and status", async () => {
    const app = buildApp();
    await app.inject({ method: "GET", url: "/livez" });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toMatch(
      /http_requests_total\{method="GET",route="\/livez",status="200"\} [1-9][0-9]*/,
    );
    await app.close();
  });

  it("uses the route template, not the raw path, to bound cardinality", async () => {
    const app = buildApp();
    // hit an unauthenticated, param'd route; it 401s but should still be templated
    await app.inject({ method: "GET", url: "/channels/abc-123/messages" });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain('route="/channels/:cid/messages"');
    expect(res.body).not.toContain("abc-123");
    await app.close();
  });
});
