import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { inArray } from "drizzle-orm";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { schedulerJobs } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { dbSchedulerStore } from "../../src/db/repositories/scheduler-jobs.js";
import { DurableScheduler } from "../../src/scheduler/scheduler.js";
import type { SessionLogger } from "../../src/runtime/manager.js";
import type { BackoffPolicy } from "../../src/durable-workflow/types.js";

/**
 * #559 acceptance, against real Postgres: the leader lease is an atomic compare-and-swap UPDATE, so under
 * genuine concurrency exactly one instance fires each interval; and the cursor is a persisted row, so a
 * fresh process (a restart) resumes from it instead of skipping or double-firing.
 */

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const backoff: BackoffPolicy = { baseMs: 1_000, factor: 2, capMs: 8_000, maxAttempts: 5 };

/** A mutable epoch-ms clock injected into the scheduler so the DB `next_run_at <= now` predicate is deterministic. */
function makeClock(start: number) {
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
  clock: { now: () => number },
  instanceId: string,
): DurableScheduler {
  return new DurableScheduler({
    store: dbSchedulerStore,
    logger: silentLogger,
    instanceId,
    leaseMs: 60_000,
    pollIntervalMs: 5_000,
    jobTimeoutMs: 300_000,
    backoff,
    now: clock.now,
  });
}

const createdKeys: string[] = [];

afterAll(async () => {
  if (createdKeys.length) {
    await db.delete(schedulerJobs).where(inArray(schedulerJobs.jobKey, createdKeys));
  }
  await Promise.allSettled([closeDb(), closeRedis()]);
});

describe("DurableScheduler (#559) — durable single-leader, against Postgres", () => {
  let jobKey: string;
  beforeEach(() => {
    jobKey = `it-sched-${newId()}`;
    createdKeys.push(jobKey);
  });

  it("fires EXACTLY ONCE per interval across N contending instances (atomic leader lease)", async () => {
    // Headroom: the first poll materializes the shared row under N-way connection contention on a cold pool.
    const N = 6;
    const clock = makeClock(2_000_000_000_000); // a fixed epoch-ms far from any real wall clock
    const calls = { n: 0 };
    const run = async () => {
      calls.n += 1;
    };
    const schedulers = Array.from({ length: N }, (_, i) => makeScheduler(clock, `inst-${i}`));
    for (const s of schedulers) s.register({ key: jobKey, intervalMs: 10_000, run });

    // First poll across all instances materializes the single shared row (no fire — cursor is one interval out).
    await Promise.all(schedulers.map((s) => s.tick()));
    expect(calls.n).toBe(0);

    // Drive several intervals; at each, ALL instances poll concurrently and contend for the one lease.
    for (let interval = 1; interval <= 3; interval++) {
      clock.advance(10_000);
      await Promise.all(schedulers.map((s) => s.tick()));
      // Exactly one instance won the claim this interval — never more.
      expect(calls.n).toBe(interval);
    }

    // Observability: the persisted row carries last-run / next-run / ok status and no held lease.
    const state = await dbSchedulerStore.get(jobKey);
    expect(state?.lastStatus).toBe("ok");
    expect(state?.lastRunAtMs).toBe(clock.now());
    expect(state?.nextRunAtMs).toBe(clock.now() + 10_000);
    expect(state?.lockedBy).toBeNull();
    expect(state?.lockedUntilMs).toBeNull();
  }, 60_000);

  it("resumes from the persisted cursor after a restart (no skip, no double-fire)", async () => {
    const clock = makeClock(2_000_000_500_000);
    const calls = { n: 0 };
    const run = async () => {
      calls.n += 1;
    };

    // Instance 1: materialize, then fire one interval. The cursor is persisted in Postgres.
    const first = makeScheduler(clock, "inst-1");
    first.register({ key: jobKey, intervalMs: 10_000, run });
    await first.tick();
    clock.advance(10_000);
    await first.tick();
    expect(calls.n).toBe(1);
    const persistedCursor = (await dbSchedulerStore.get(jobKey))!.nextRunAtMs;

    // "kill -9" then a brand-new process: a fresh scheduler over the same table. It must keep the cursor.
    const restarted = makeScheduler(clock, "inst-2");
    restarted.register({ key: jobKey, intervalMs: 10_000, run });
    await restarted.tick(); // before the cursor elapses → no double fire on boot
    expect(calls.n).toBe(1);
    expect((await dbSchedulerStore.get(jobKey))!.nextRunAtMs).toBe(persistedCursor);

    // When the persisted cursor elapses, the restarted instance fires it — the tick resumed across restart.
    clock.set(persistedCursor);
    await restarted.tick();
    expect(calls.n).toBe(2);
  });

  it("fires an overdue cursor on first poll after a crash that outlasted several intervals", async () => {
    const clock = makeClock(2_000_001_000_000);
    // The cursor was persisted before a long outage.
    await dbSchedulerStore.ensureJob({ jobKey, intervalMs: 10_000, nowMs: clock.now() });
    clock.advance(100_000); // 10 intervals of downtime

    const calls = { n: 0 };
    const scheduler = makeScheduler(clock, "inst-recover");
    scheduler.register({ key: jobKey, intervalMs: 10_000, run: async () => void calls.n++ });
    await scheduler.tick();
    expect(calls.n).toBe(1);
  });
});
