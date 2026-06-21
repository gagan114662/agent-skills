import { describe, it, expect } from "vitest";
import { DurableScheduler, type DurableSchedulerDeps } from "../../src/scheduler/scheduler.js";
import { InMemorySchedulerStore } from "../../src/scheduler/store.js";
import type { SchedulerStore } from "../../src/scheduler/types.js";
import type { SessionLogger } from "../../src/runtime/manager.js";
import type { BackoffPolicy } from "../../src/durable-workflow/types.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const backoff: BackoffPolicy = { baseMs: 1_000, factor: 2, capMs: 8_000, maxAttempts: 5 };

/** A mutable epoch-ms clock so cadence/backoff are deterministic without wall-clock waits. */
function makeClock(start = 1_000_000) {
  const state = { ms: start };
  return {
    now: () => state.ms,
    advance: (ms: number) => {
      state.ms += ms;
    },
    set: (ms: number) => {
      state.ms = ms;
    },
  };
}

function makeScheduler(
  store: SchedulerStore,
  clock: { now: () => number },
  over: Partial<DurableSchedulerDeps> = {},
): DurableScheduler {
  return new DurableScheduler({
    store,
    logger: silentLogger,
    instanceId: "inst-A",
    leaseMs: 60_000,
    pollIntervalMs: 5_000,
    jobTimeoutMs: 300_000,
    backoff,
    now: clock.now,
    ...over,
  });
}

describe("DurableScheduler (#559)", () => {
  it("does not enroll a job with interval <= 0 (mirrors start(0) being a no-op)", async () => {
    const store = new InMemorySchedulerStore();
    const clock = makeClock();
    const scheduler = makeScheduler(store, clock);
    const calls = { n: 0 };
    scheduler.register({ key: "disabled", intervalMs: 0, run: async () => void calls.n++ });
    await scheduler.tick();
    expect(calls.n).toBe(0);
    expect(await store.get("disabled")).toBeNull();
  });

  it("fires after one interval, not before, then advances the persisted cursor", async () => {
    const store = new InMemorySchedulerStore();
    const clock = makeClock();
    const scheduler = makeScheduler(store, clock);
    const calls = { n: 0 };
    scheduler.register({ key: "planning", intervalMs: 10_000, run: async () => void calls.n++ });

    // First poll (≈ boot time) materializes the row but does not fire — the cursor is one interval out.
    await scheduler.tick();
    expect(calls.n).toBe(0);
    const created = await store.get("planning");
    expect(created?.nextRunAtMs).toBe(clock.now() + 10_000);

    // At one interval: fires once and the cursor moves to now + interval.
    clock.advance(10_000);
    await scheduler.tick();
    expect(calls.n).toBe(1);
    const after = await store.get("planning");
    expect(after?.lastRunAtMs).toBe(clock.now());
    expect(after?.nextRunAtMs).toBe(clock.now() + 10_000);
    expect(after?.lastStatus).toBe("ok");
    expect(after?.lockedBy).toBeNull();
  });

  it("fires EXACTLY ONCE across two contending instances sharing one store", async () => {
    const store = new InMemorySchedulerStore();
    const clock = makeClock();
    const calls = { n: 0 };
    const run = async () => {
      calls.n += 1;
    };
    const a = makeScheduler(store, clock, { instanceId: "inst-A" });
    const b = makeScheduler(store, clock, { instanceId: "inst-B" });
    a.register({ key: "workflows", intervalMs: 10_000, run });
    b.register({ key: "workflows", intervalMs: 10_000, run });

    // Materialize the shared row (first poll), then make the interval due.
    await Promise.all([a.tick(), b.tick()]);
    expect(calls.n).toBe(0);
    clock.advance(10_000);

    // Both instances poll concurrently for the same due interval.
    await Promise.all([a.tick(), b.tick()]);
    expect(calls.n).toBe(1);

    // The winner advanced the cursor; a second concurrent round in the same interval fires nothing.
    await Promise.all([a.tick(), b.tick()]);
    expect(calls.n).toBe(1);

    // Next interval: exactly one more fire.
    clock.advance(10_000);
    await Promise.all([a.tick(), b.tick()]);
    expect(calls.n).toBe(2);
  });

  it("retries a failing tick on bounded backoff and records the failure (no-hang)", async () => {
    const store = new InMemorySchedulerStore();
    const clock = makeClock();
    const scheduler = makeScheduler(store, clock);
    let fail = true;
    scheduler.register({
      key: "verifiers",
      intervalMs: 30_000,
      run: async () => {
        if (fail) throw new Error("boom: downstream unavailable");
      },
    });

    await scheduler.tick(); // materialize row at base
    clock.advance(30_000);
    await scheduler.tick(); // first run fails
    let s = await store.get("verifiers");
    expect(s?.lastStatus).toBe("error");
    expect(s?.lastError).toContain("boom");
    expect(s?.consecutiveFailures).toBe(1);
    // Backed off by baseMs (1s), NOT the full 30s interval → it retries soon, never hangs.
    expect(s?.nextRunAtMs).toBe(clock.now() + 1_000);

    // Recover: the next due run succeeds and resets the failure counter + resumes the steady cadence.
    fail = false;
    clock.advance(1_000);
    await scheduler.tick();
    s = await store.get("verifiers");
    expect(s?.lastStatus).toBe("ok");
    expect(s?.consecutiveFailures).toBe(0);
    expect(s?.nextRunAtMs).toBe(clock.now() + 30_000);
  });

  it("resumes from the persisted cursor after a simulated restart (does not reset)", async () => {
    const store = new InMemorySchedulerStore();
    const clock = makeClock();
    const calls = { n: 0 };
    const run = async () => {
      calls.n += 1;
    };

    // Instance 1 materializes the row, then runs one tick at the due interval.
    const first = makeScheduler(store, clock, { instanceId: "inst-1" });
    first.register({ key: "planning", intervalMs: 10_000, run });
    await first.tick();
    clock.advance(10_000);
    await first.tick();
    expect(calls.n).toBe(1);
    const cursorAfter = (await store.get("planning"))!.nextRunAtMs;

    // "kill -9" then a NEW process: a fresh scheduler over the SAME store. ensureJob must keep the cursor.
    const restarted = makeScheduler(store, clock, { instanceId: "inst-2" });
    restarted.register({ key: "planning", intervalMs: 10_000, run });
    await restarted.tick();
    expect(calls.n).toBe(1); // not yet due → no double fire on boot
    expect((await store.get("planning"))!.nextRunAtMs).toBe(cursorAfter);

    // Once the persisted cursor elapses, the restarted instance fires it.
    clock.set(cursorAfter);
    await restarted.tick();
    expect(calls.n).toBe(2);
  });

  it("fires an overdue cursor immediately after a restart that outlasted several intervals", async () => {
    const store = new InMemorySchedulerStore();
    const clock = makeClock();
    // Seed a job whose cursor is far in the past (the loop was paused by a long crash).
    await store.ensureJob({ jobKey: "planning", intervalMs: 10_000, nowMs: clock.now() });
    clock.advance(100_000); // 10 intervals of downtime

    const calls = { n: 0 };
    const scheduler = makeScheduler(store, clock);
    scheduler.register({ key: "planning", intervalMs: 10_000, run: async () => void calls.n++ });
    await scheduler.tick();
    expect(calls.n).toBe(1); // overdue → fires on the first poll after restart
  });

  it("abandons a wedged tick at the jobTimeoutMs bound and backs off (runtime no-hang)", async () => {
    const store = new InMemorySchedulerStore();
    const clock = makeClock();
    const scheduler = makeScheduler(store, clock, { jobTimeoutMs: 20 });
    scheduler.register({
      key: "workflows",
      intervalMs: 30_000,
      // Never resolves on its own within the bound — simulates a hung tickAll.
      run: () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
    });
    await scheduler.tick(); // materialize row at base
    clock.advance(30_000);
    await scheduler.tick();
    const s = await store.get("workflows");
    expect(s?.lastStatus).toBe("error");
    expect(s?.lastError).toContain("timeout");
    expect(s?.lockedBy).toBeNull(); // lease released even though the tick was abandoned
  });

  it("exposes a last-run / next-run observability snapshot", async () => {
    const store = new InMemorySchedulerStore();
    const clock = makeClock();
    const scheduler = makeScheduler(store, clock);
    scheduler.register({ key: "planning", intervalMs: 10_000, run: async () => {} });
    await scheduler.tick(); // materialize row at base
    clock.advance(10_000);
    await scheduler.tick();
    const snap = await scheduler.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ jobKey: "planning", lastStatus: "ok" });
    expect(snap[0].lastRunAtMs).toBe(clock.now());
    expect(snap[0].nextRunAtMs).toBe(clock.now() + 10_000);
  });
});
