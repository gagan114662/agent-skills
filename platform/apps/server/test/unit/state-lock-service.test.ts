import { describe, it, expect } from "vitest";
import { StateLockService } from "../../src/state-lock/service.js";
import { InMemorySharedStateStore, type SharedStateStore } from "../../src/state-lock/store.js";
import { KeyedMutex } from "../../src/state-lock/mutex.js";
import { checkVersionHistory } from "../../src/state-lock/invariants.js";
import {
  StateConflictError,
  StateExistsError,
  StateNotFoundError,
  type CreateStateInput,
  type SharedStateRecord,
} from "../../src/state-lock/types.js";
import type { StateLockCaps } from "../../src/state-lock/caps.js";

const WS = "ws-1";
const ENABLED: StateLockCaps = { enabled: true, maxRetries: 64 };
const FIXED_CLOCK = () => 1_700_000_000_000;

function makeService(opts: { caps?: StateLockCaps; store?: SharedStateStore; mutex?: KeyedMutex } = {}) {
  const store = opts.store ?? new InMemorySharedStateStore();
  const service = new StateLockService({
    store,
    caps: opts.caps ?? ENABLED,
    now: FIXED_CLOCK,
    mutex: opts.mutex,
  });
  return { store, service };
}

/**
 * A store wrapper that yields control on `get` and `compareAndSwap`, widening the window in which
 * concurrent writers interleave. It makes a race a near-certainty rather than a fluke, so the stress test
 * actually exercises contention instead of getting lucky with scheduling.
 */
class YieldingStore implements SharedStateStore {
  constructor(private readonly inner: SharedStateStore) {}
  async create<T>(input: CreateStateInput<T> & { updatedAtMs: number }) {
    return this.inner.create<T>(input);
  }
  async get<T>(workspaceId: string, key: string) {
    await Promise.resolve();
    await Promise.resolve();
    return this.inner.get<T>(workspaceId, key);
  }
  async compareAndSwap<T>(workspaceId: string, key: string, expected: number, next: SharedStateRecord<T>) {
    await Promise.resolve();
    return this.inner.compareAndSwap<T>(workspaceId, key, expected, next);
  }
  async list<T>(workspaceId: string) {
    return this.inner.list<T>(workspaceId);
  }
}

describe("StateLockService basics", () => {
  it("init seeds version 1 and read returns it", async () => {
    const { service } = makeService();
    const created = await service.init(WS, "counter", { count: 0 });
    expect(created).toMatchObject({ workspaceId: WS, key: "counter", version: 1, value: { count: 0 } });
    const read = await service.read<{ count: number }>(WS, "counter");
    expect(read?.value.count).toBe(0);
  });

  it("update advances version by one per commit", async () => {
    const { service } = makeService();
    await service.init(WS, "counter", { count: 0 });
    const a = await service.update<{ count: number }>(WS, "counter", (v) => ({ count: v.count + 1 }));
    const b = await service.update<{ count: number }>(WS, "counter", (v) => ({ count: v.count + 1 }));
    expect(a.version).toBe(2);
    expect(b.version).toBe(3);
    expect(b.value.count).toBe(2);
  });

  it("rejects a duplicate init", async () => {
    const { service } = makeService();
    await service.init(WS, "counter", { count: 0 });
    await expect(service.init(WS, "counter", { count: 0 })).rejects.toThrow(StateExistsError);
  });

  it("rejects an update to state that was never initialized", async () => {
    const { service } = makeService();
    await expect(service.update(WS, "missing", (v) => v)).rejects.toThrow(StateNotFoundError);
  });

  it("scopes reads to the workspace (#3 IDOR boundary)", async () => {
    const { service } = makeService();
    await service.init(WS, "counter", { count: 1 });
    expect(await service.read("other-ws", "counter")).toBeNull();
  });
});

describe("StateLockService concurrency — issue #639 acceptance", () => {
  const N = 200;

  it("baseline: a naive read-modify-write WITHOUT serialization loses updates", async () => {
    // This reproduces the bug. Each racer reads, increments, and CASes exactly once, ignoring a lost race
    // (no mutex, no retry). Under interleaving, only the first of each colliding batch commits — the rest
    // are silently dropped — so the final count falls short of N.
    const store = new YieldingStore(new InMemorySharedStateStore());
    await store.create({ workspaceId: WS, key: "counter", value: { count: 0 }, updatedAtMs: 0 });

    const naiveIncrement = async () => {
      const cur = await store.get<{ count: number }>(WS, "counter");
      if (!cur) throw new Error("missing");
      await store.compareAndSwap<{ count: number }>(WS, "counter", cur.version, {
        ...cur,
        version: cur.version + 1,
        value: { count: cur.value.count + 1 },
      });
    };

    await Promise.all(Array.from({ length: N }, naiveIncrement));
    const final = await store.get<{ count: number }>(WS, "counter");
    // The whole point of the bug: updates were lost.
    expect(final!.value.count).toBeLessThan(N);
  });

  it("fix: N concurrent writers via update() leave state consistent with NO lost updates", async () => {
    const { store, service } = makeService({ store: new YieldingStore(new InMemorySharedStateStore()) });
    await service.init(WS, "counter", { count: 0 });

    await Promise.all(
      Array.from({ length: N }, () =>
        service.update<{ count: number }>(WS, "counter", (v) => ({ count: v.count + 1 })),
      ),
    );

    const final = await store.get<{ count: number }>(WS, "counter");
    // Every single increment landed: the counter equals N and the version advanced exactly N times.
    expect(final!.value.count).toBe(N);
    expect(final!.version).toBe(N + 1);
  });

  it("fix: correctness holds even with in-process serialization disabled (store CAS is the backstop)", async () => {
    // Disable the per-key mutex entirely; only the optimistic version CAS + retry guards correctness — the
    // exact situation across separate replicas. No update may be lost; contention only costs retries.
    const { store, service } = makeService({
      store: new YieldingStore(new InMemorySharedStateStore()),
      mutex: undefined,
      caps: { enabled: false, maxRetries: N * 4 },
    });
    await service.init(WS, "counter", { count: 0 });

    await Promise.all(
      Array.from({ length: N }, () =>
        service.update<{ count: number }>(WS, "counter", (v) => ({ count: v.count + 1 })),
      ),
    );

    const final = await store.get<{ count: number }>(WS, "counter");
    expect(final!.value.count).toBe(N);
    expect(final!.version).toBe(N + 1);
  });

  it("keeps independent entities isolated under concurrent writes", async () => {
    const { service } = makeService();
    const keys = ["a", "b", "c", "d"];
    for (const k of keys) await service.init(WS, k, { count: 0 });

    const perKey = 50;
    await Promise.all(
      keys.flatMap((k) =>
        Array.from({ length: perKey }, () =>
          service.update<{ count: number }>(WS, k, (v) => ({ count: v.count + 1 })),
        ),
      ),
    );

    for (const k of keys) {
      const rec = await service.read<{ count: number }>(WS, k);
      expect(rec?.value.count).toBe(perKey);
      expect(rec?.version).toBe(perKey + 1);
    }
  });

  it("non-increment mutations (list append) also lose nothing", async () => {
    const { service } = makeService();
    await service.init<{ items: number[] }>(WS, "log", { items: [] });

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        service.update<{ items: number[] }>(WS, "log", (v) => ({ items: [...v.items, i] })),
      ),
    );

    const final = await service.read<{ items: number[] }>(WS, "log");
    expect(final!.value.items).toHaveLength(N);
    // Every distinct index 0..N-1 made it in — nothing clobbered.
    expect(new Set(final!.value.items).size).toBe(N);
  });

  it("surfaces a StateConflictError (not a lost update) when the retry budget is too small", async () => {
    // A pathologically small budget with the mutex off forces some writers to exhaust their retries. The
    // guarantee under contention is "fail loudly", never "succeed while dropping a write".
    const { service } = makeService({
      store: new YieldingStore(new InMemorySharedStateStore()),
      caps: { enabled: false, maxRetries: 1 },
    });
    await service.init(WS, "counter", { count: 0 });

    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        service.update<{ count: number }>(WS, "counter", (v) => ({ count: v.count + 1 })),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const conflicts = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof StateConflictError,
    ).length;

    expect(ok + conflicts).toBe(25); // every rejection is a *conflict*, never a corruption/other error
    // The committed version reflects exactly the number that succeeded — no lost updates among them.
    const final = await service.read<{ count: number }>(WS, "counter");
    expect(final!.value.count).toBe(ok);
    expect(final!.version).toBe(ok + 1);
  });

  it("a reconstructed version history of a serialized run is gap-free", async () => {
    const { service } = makeService();
    await service.init(WS, "counter", { count: 0 });
    const versions: number[] = [];
    for (let i = 0; i < 10; i++) {
      const rec = await service.update<{ count: number }>(WS, "counter", (v) => ({ count: v.count + 1 }));
      versions.push(rec.version);
    }
    expect(checkVersionHistory(versions)).toBeNull();
    expect(versions).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});
