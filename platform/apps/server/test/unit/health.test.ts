import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the dependency pings so this is a hermetic unit test of the /healthz contract.
// Real Postgres/Redis connectivity is proven by the demo (scripts/demos/*.sh, recorded as the
// PR video) and the integration tests (test/integration) which run against a real database.
const pingDb = vi.fn<() => Promise<boolean>>();
const pingRedis = vi.fn<() => Promise<boolean>>();

vi.mock("../../src/db/index.js", () => ({ pingDb, closeDb: vi.fn() }));
vi.mock("../../src/redis/index.js", () => ({ pingRedis, closeRedis: vi.fn() }));

const { buildApp } = await import("../../src/app.js");
const { registerBackgroundLoop, resetBackgroundLoopsForTest } = await import("../../src/ops/loop-liveness.js");

describe("GET /healthz", () => {
  beforeEach(() => {
    pingDb.mockReset();
    pingRedis.mockReset();
    resetBackgroundLoopsForTest();
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

describe("GET /readyz loop liveness", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalReloadEnv = process.env.RELOAD_ENV;

  beforeEach(() => {
    pingDb.mockReset();
    pingRedis.mockReset();
    resetBackgroundLoopsForTest();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalReloadEnv === undefined) delete process.env.RELOAD_ENV;
    else process.env.RELOAD_ENV = originalReloadEnv;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalReloadEnv === undefined) delete process.env.RELOAD_ENV;
    else process.env.RELOAD_ENV = originalReloadEnv;
    resetBackgroundLoopsForTest();
  });

  it("fails production readiness when a critical background loop is registered disabled", async () => {
    process.env.RELOAD_ENV = "production";
    pingDb.mockResolvedValue(true);
    pingRedis.mockResolvedValue(true);
    registerBackgroundLoop({
      name: "watchdog",
      intervalMs: 0,
      critical: true,
      now: new Date("2026-06-24T00:00:00Z"),
    });

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "not_ready",
      db: "up",
      redis: "up",
      loops: { status: "not_ready", disabledCritical: ["watchdog"] },
    });
    await app.close();
  });
});

// #292 — the build-version probe the deploy version-advance gate reads. `/readyz` (deps only) passes on
// the OLD image too, so it cannot catch a deploy that silently stayed on the previous version (the v80
// blocker). `/version` exposes the git SHA baked into the running image so the deploy can confirm the
// running release advanced to the deployed commit.
describe("GET /version", () => {
  beforeEach(() => {
    pingDb.mockReset();
    pingRedis.mockReset();
    delete process.env.GIT_SHA;
    delete process.env.GITHUB_SHA;
  });

  it("returns the git SHA stamped into the running image (GIT_SHA)", async () => {
    process.env.GIT_SHA = "0123456789abcdef0123456789abcdef01234567";
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/version" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: "0123456789abcdef0123456789abcdef01234567" });
    await app.close();
  });

  it("returns an empty version for an un-stamped build (consumers treat as unknown, never a match)", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/version" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: "" });
    await app.close();
  });
});
