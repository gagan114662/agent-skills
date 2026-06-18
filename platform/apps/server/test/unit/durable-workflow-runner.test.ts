import { describe, it, expect } from "vitest";
import { DurableRunner, type StartOptions } from "../../src/durable-workflow/runner.js";
import { InMemoryDurableRunStore } from "../../src/durable-workflow/store.js";
import type { BackoffPolicy, StepHandler, StepOutcome } from "../../src/durable-workflow/types.js";

/** A controllable clock: `now()` reads it, `sleep(ms)` advances it (so backoff/deadline are deterministic). */
class FakeClock {
  constructor(public ms = 1_000) {}
  now = (): number => this.ms;
  sleep = async (ms: number): Promise<void> => {
    this.ms += Math.max(0, ms);
  };
  /** A frozen clock: `sleep` does NOT advance time (used to prove the no-hang backstop). */
  frozenSleep = async (): Promise<void> => {};
}

const policy: BackoffPolicy = { baseMs: 1000, factor: 2, capMs: 8000, maxAttempts: 5 };

function startOpts(over: Partial<StartOptions<Record<string, never>>> = {}): StartOptions<
  Record<string, never>
> {
  return {
    workspaceId: "ws-1",
    workflowKey: "test_wait",
    idempotencyKey: "job-1",
    timeoutMs: 100_000,
    initialState: {},
    ...over,
  };
}

/** A poll handler that returns `pending` N times, then `done(result)`, counting how often it ran. */
function pollHandler(pendingCount: number, result: string) {
  const calls = { n: 0 };
  const handler: StepHandler<Record<string, never>, string> = {
    async step(): Promise<StepOutcome<string>> {
      calls.n += 1;
      if (calls.n <= pendingCount) return { type: "pending" };
      return { type: "done", result };
    },
  };
  return { handler, calls };
}

describe("DurableRunner — suspend / resume / persist (advance, one step at a time)", () => {
  it("suspends with growing backoff between attempts, then succeeds and persists the result", async () => {
    const store = new InMemoryDurableRunStore();
    const clock = new FakeClock(1_000);
    const runner = new DurableRunner({ store, now: clock.now, sleep: clock.sleep });
    const { handler } = pollHandler(2, "https://live.example/");

    let rec = await runner.start<Record<string, never>, string>(startOpts());
    expect(rec.status).toBe("running");

    // Attempt 1 → pending → suspended, next attempt one base unit out.
    rec = await runner.advance(rec, handler, policy);
    expect(rec.status).toBe("suspended");
    expect(rec.attempts).toBe(1);
    expect(rec.nextAttemptAtMs).toBe(1_000 + 1000); // base * 2^0

    // Resume from PERSISTED state (read the row back — never assume, #200 §3). Advance again is a no-op
    // while still inside the backoff window.
    const reread = await store.get<Record<string, never>, string>(rec.id);
    expect(reread?.status).toBe("suspended");
    clock.ms = 1_500; // still before nextAttemptAt (2_000)
    const waited = await runner.advance(reread!, handler, policy);
    expect(waited.status).toBe("suspended");
    expect(waited.attempts).toBe(1); // no new attempt ran

    // Cursor elapsed → attempt 2 → pending → suspended again with a LARGER backoff (base * 2^1).
    clock.ms = 2_000;
    rec = await runner.advance(waited, handler, policy);
    expect(rec.status).toBe("suspended");
    expect(rec.attempts).toBe(2);
    expect(rec.nextAttemptAtMs).toBe(2_000 + 2000);

    // Cursor elapsed → attempt 3 → done.
    clock.ms = 4_000;
    rec = await runner.advance(rec, handler, policy);
    expect(rec.status).toBe("succeeded");
    expect(rec.result).toBe("https://live.example/");

    // The terminal result is durable — a fresh read returns it.
    const final = await store.get<Record<string, never>, string>(rec.id);
    expect(final?.status).toBe("succeeded");
    expect(final?.result).toBe("https://live.example/");
  });
});

describe("DurableRunner — idempotent resume (a resumed step never double-applies, #200 §2)", () => {
  it("a repeated start RESUMES the same run (does not fork a duplicate)", async () => {
    const store = new InMemoryDurableRunStore();
    const runner = new DurableRunner({ store, now: () => 1_000, sleep: async () => {} });
    const first = await runner.start(startOpts());
    const second = await runner.start(startOpts());
    expect(second.id).toBe(first.id);
  });

  it("advancing a SUCCEEDED run never calls the handler again and keeps the result", async () => {
    const store = new InMemoryDurableRunStore();
    const clock = new FakeClock();
    const runner = new DurableRunner({ store, now: clock.now, sleep: clock.sleep });
    const { handler, calls } = pollHandler(0, "RESULT"); // done on first attempt

    const done = await runner.runToCompletion(startOpts(), handler, policy);
    expect(done.status).toBe("succeeded");
    expect(calls.n).toBe(1);

    // Resume after completion: handler is NOT called again; the persisted result is returned (no re-apply).
    const again = await runner.runToCompletion(startOpts(), handler, policy);
    expect(again.id).toBe(done.id);
    expect(again.status).toBe("succeeded");
    expect(again.result).toBe("RESULT");
    expect(calls.n).toBe(1); // <-- the side effect did not run a second time
  });
});

describe("DurableRunner — retry-with-backoff failures", () => {
  it("a RETRYABLE failure suspends with backoff and counts toward the attempt cap", async () => {
    const store = new InMemoryDurableRunStore();
    const clock = new FakeClock();
    const runner = new DurableRunner({ store, now: clock.now, sleep: clock.sleep });
    const handler: StepHandler<Record<string, never>, string> = {
      async step() {
        return { type: "failed", retryable: true, error: "rate_limited" };
      },
    };
    let rec = await runner.start<Record<string, never>, string>(startOpts());
    rec = await runner.advance(rec, handler, policy);
    expect(rec.status).toBe("suspended");
    expect(rec.attempts).toBe(1);
    expect(rec.error).toBe("rate_limited");
    expect(rec.nextAttemptAtMs).toBe(clock.ms + 1000);
  });

  it("a NON-retryable failure fails fast (no further attempts)", async () => {
    const store = new InMemoryDurableRunStore();
    const runner = new DurableRunner({ store, now: () => 1_000, sleep: async () => {} });
    const handler: StepHandler<Record<string, never>, string> = {
      async step() {
        return { type: "failed", retryable: false, error: "not_found" };
      },
    };
    let rec = await runner.start<Record<string, never>, string>(startOpts());
    rec = await runner.advance(rec, handler, policy);
    expect(rec.status).toBe("failed");
    expect(rec.error).toBe("not_found");
    expect(rec.attempts).toBe(1);
  });

  it("a THROWN handler is treated as a retryable transient (suspend + backoff, never crash the run)", async () => {
    const store = new InMemoryDurableRunStore();
    const clock = new FakeClock();
    const runner = new DurableRunner({ store, now: clock.now, sleep: clock.sleep });
    const handler: StepHandler<Record<string, never>, string> = {
      async step() {
        throw new Error("ECONNRESET while polling");
      },
    };
    let rec = await runner.start<Record<string, never>, string>(startOpts());
    rec = await runner.advance(rec, handler, policy);
    expect(rec.status).toBe("suspended");
    expect(rec.error).toContain("ECONNRESET");
  });
});

describe("DurableRunner — timeout / no-hang (the whole point of replacing the blocking until-wait)", () => {
  it("runToCompletion FAILS with timeout once the deadline elapses — it does not hang", async () => {
    const store = new InMemoryDurableRunStore();
    const clock = new FakeClock(0);
    const runner = new DurableRunner({ store, now: clock.now, sleep: clock.sleep });
    // Always pending: the build never finishes. The deadline must end the wait.
    const handler: StepHandler<Record<string, never>, string> = {
      async step() {
        return { type: "pending" };
      },
    };
    const rec = await runner.runToCompletion(
      startOpts({ timeoutMs: 5_000 }),
      handler,
      { baseMs: 1000, factor: 1, capMs: 1000, maxAttempts: 1000 }, // attempt cap can't save it; the deadline does
    );
    expect(rec.status).toBe("failed");
    expect(rec.error).toBe("timeout");
    expect(clock.ms).toBeGreaterThanOrEqual(5_000); // advanced to the deadline, then stopped
  });

  it("runToCompletion is EXHAUSTED once attempts hit the cap (bounded retries)", async () => {
    const store = new InMemoryDurableRunStore();
    const clock = new FakeClock(0);
    const runner = new DurableRunner({ store, now: clock.now, sleep: clock.sleep });
    const { handler, calls } = pollHandler(1000, "never"); // always pending within the run
    const rec = await runner.runToCompletion(
      startOpts({ timeoutMs: 10_000_000 }), // deadline far away; the attempt cap must be the bound
      handler,
      { baseMs: 1, factor: 1, capMs: 1, maxAttempts: 4 },
    );
    expect(rec.status).toBe("failed");
    expect(rec.error).toBe("max_attempts");
    expect(calls.n).toBe(4);
  });

  it("TERMINATES even with a frozen clock (the absolute iteration backstop) — never an infinite loop", async () => {
    const store = new InMemoryDurableRunStore();
    const clock = new FakeClock(0);
    // `frozenSleep` never advances time: now() stays 0, so the deadline is never reached and the backoff
    // cursor never elapses. Only the absolute iteration cap can break the loop.
    const runner = new DurableRunner({ store, now: clock.now, sleep: clock.frozenSleep });
    const handler: StepHandler<Record<string, never>, string> = {
      async step() {
        return { type: "pending" };
      },
    };
    const rec = await runner.runToCompletion(
      startOpts({ timeoutMs: 1_000_000 }),
      handler,
      { baseMs: 1000, factor: 2, capMs: 8000, maxAttempts: 5 },
    );
    // The promise RESOLVES (the test would time out otherwise) and the run is fail-closed, not left running.
    expect(rec.status).toBe("failed");
    expect(["no_progress", "max_attempts", "timeout"]).toContain(rec.error);
  });
});

describe("DurableRunner — the #13 always-gate for irreversible steps (#200 §4)", () => {
  it("parks an irreversible step in waiting_approval and never runs it without an approval", async () => {
    const store = new InMemoryDurableRunStore();
    const runner = new DurableRunner({ store, now: () => 1_000, sleep: async () => {} });
    const { handler, calls } = pollHandler(0, "SHIPPED");

    let rec = await runner.start<Record<string, never>, string>(
      startOpts({ requiresApproval: true }),
    );
    rec = await runner.advance(rec, handler, policy);
    expect(rec.status).toBe("waiting_approval");
    expect(calls.n).toBe(0); // the irreversible side effect did NOT run

    // Owner approves → the approval id is attached → the step is now allowed to run.
    rec = await store.save({ ...rec, approvalRequestId: "appr-42" });
    rec = await runner.advance(rec, handler, policy);
    expect(rec.status).toBe("succeeded");
    expect(rec.result).toBe("SHIPPED");
    expect(calls.n).toBe(1);
  });
});
