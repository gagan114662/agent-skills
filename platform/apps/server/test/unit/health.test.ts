import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the dependency pings so this is a hermetic unit test of the /healthz contract.
// Real Postgres/Redis connectivity is proven by the demo (scripts/demos/*.sh, recorded as the
// PR video) and the integration tests (test/integration) which run against a real database.
const pingDb = vi.fn<() => Promise<boolean>>();
const pingRedis = vi.fn<() => Promise<boolean>>();

vi.mock("../../src/db/index.js", () => ({ pingDb, closeDb: vi.fn() }));
vi.mock("../../src/redis/index.js", () => ({ pingRedis, closeRedis: vi.fn() }));

const { buildApp } = await import("../../src/app.js");

describe("GET /healthz", () => {
  beforeEach(() => {
    pingDb.mockReset();
    pingRedis.mockReset();
  });

  it("returns 200 ok when db and redis are both up", async () => {
    pingDb.mockResolvedValue(true);
    pingRedis.mockResolvedValue(true);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "up", redis: "up" });
    await app.close();
  });

  it("reports degraded with the failing dependency marked down", async () => {
    pingDb.mockResolvedValue(true);
    pingRedis.mockResolvedValue(false);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "degraded", db: "up", redis: "down" });
    await app.close();
  });
});
