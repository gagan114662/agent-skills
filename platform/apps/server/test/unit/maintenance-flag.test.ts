import { describe, it, expect } from "vitest";
import { getMaintenanceState, setMaintenance, MAINTENANCE_KEY } from "../../src/maintenance/flag.js";
import type { RedisLike } from "../../src/maintenance/flag.js";

/** A tiny in-memory Redis double exposing only the get/set/del the flag uses. */
function fakeRedis(): RedisLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
    async del(key) {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    },
  };
}

/** A Redis double whose every call throws, to exercise the fail-open path. */
const brokenRedis: RedisLike = {
  get: () => Promise.reject(new Error("ECONNREFUSED")),
  set: () => Promise.reject(new Error("ECONNREFUSED")),
  del: () => Promise.reject(new Error("ECONNREFUSED")),
};

describe("maintenance flag (Redis-backed)", () => {
  it("reads disabled when the key is absent", async () => {
    const redis = fakeRedis();
    expect(await getMaintenanceState(redis)).toMatchObject({ enabled: false });
  });

  it("setMaintenance(true) persists the flag with metadata; getMaintenanceState reads it back", async () => {
    const redis = fakeRedis();
    await setMaintenance(true, { reason: "restore", by: "mem_1" }, redis);
    expect(redis.store.has(MAINTENANCE_KEY)).toBe(true);
    const state = await getMaintenanceState(redis);
    expect(state.enabled).toBe(true);
    expect(state.reason).toBe("restore");
    expect(state.by).toBe("mem_1");
    expect(state.since).toBeTruthy();
  });

  it("setMaintenance(false) clears the flag", async () => {
    const redis = fakeRedis();
    await setMaintenance(true, {}, redis);
    await setMaintenance(false, {}, redis);
    expect(redis.store.has(MAINTENANCE_KEY)).toBe(false);
    expect((await getMaintenanceState(redis)).enabled).toBe(false);
  });

  it("FAILS OPEN on a Redis error: reports disabled + unavailable, never throws", async () => {
    const state = await getMaintenanceState(brokenRedis);
    expect(state.enabled).toBe(false);
    expect(state.unavailable).toBe(true);
  });
});
