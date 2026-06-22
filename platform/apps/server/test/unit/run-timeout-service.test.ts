import { describe, it, expect, beforeEach } from "vitest";
import { RunTimeoutService, RunTimeoutError } from "../../src/run-timeout/service.js";
import { InMemoryRunTimeoutStore } from "../../src/run-timeout/store.js";
import {
  createResourceReleaser,
  type ReleaseHandle,
  type ReleaseOutcome,
  type ResourceReleaser,
} from "../../src/run-timeout/resources.js";
import type { RunTimeoutCaps } from "../../src/run-timeout/caps.js";

const RUN_MS = 30 * 60 * 1000;
const STEP_MS = 5 * 60 * 1000;
const ENABLED: RunTimeoutCaps = { enabled: true, runTimeoutMs: RUN_MS, stepTimeoutMs: STEP_MS, sweepIntervalMs: 30_000 };

/** A controllable epoch-ms clock. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

/** A releaser that records every handle it was asked to free. */
class RecordingReleaser implements ResourceReleaser {
  handles: ReleaseHandle[] = [];
  async release(handle: ReleaseHandle): Promise<ReleaseOutcome> {
    this.handles.push(handle);
    return { worktreeReleased: handle.sessionId !== null, lockReleased: handle.lockKey !== null, errors: [] };
  }
}

function makeService(opts: { caps?: RunTimeoutCaps; releaser?: ResourceReleaser; now: () => number }) {
  const store = new InMemoryRunTimeoutStore();
  const service = new RunTimeoutService({
    store,
    releaser: opts.releaser,
    caps: opts.caps ?? ENABLED,
    now: opts.now,
  });
  return { store, service };
}

describe("RunTimeoutService lifecycle", () => {
  let c: ReturnType<typeof clock>;
  beforeEach(() => {
    c = clock();
  });

  it("records a run with deadlines derived from the caps", async () => {
    const { service } = makeService({ now: c.now });
    const rec = await service.startRun({ runId: "r1", workspaceId: "ws1", sessionId: "s1", lockKey: "k1" });
    expect(rec.status).toBe("running");
    expect(rec.startedAtMs).toBe(c.now());
    expect(rec.deadlineAtMs).toBe(c.now() + RUN_MS);
    expect(rec.runTimeoutMs).toBe(RUN_MS);
    expect(rec.stepTimeoutMs).toBe(STEP_MS);
    expect(rec.lastHeartbeatAtMs).toBe(c.now());
  });

  it("honors per-run / per-step overrides on a specific run", async () => {
    const { service } = makeService({ now: c.now });
    const rec = await service.startRun({ runId: "r1", workspaceId: "ws1", runTimeoutMs: 1_000, stepTimeoutMs: 250 });
    expect(rec.runTimeoutMs).toBe(1_000);
    expect(rec.stepTimeoutMs).toBe(250);
    expect(rec.deadlineAtMs).toBe(rec.startedAtMs + 1_000);
  });

  it("tracks steps and heartbeats", async () => {
    const { service } = makeService({ now: c.now });
    await service.startRun({ runId: "r1", workspaceId: "ws1" });
    c.advance(10);
    const stepped = await service.beginStep("r1", "compile");
    expect(stepped?.stepName).toBe("compile");
    expect(stepped?.stepStartedAtMs).toBe(c.now());
    c.advance(5);
    const beat = await service.heartbeat("r1");
    expect(beat?.lastHeartbeatAtMs).toBe(c.now());
    const cleared = await service.endStep("r1");
    expect(cleared?.stepName).toBeNull();
    expect(cleared?.stepStartedAtMs).toBeNull();
  });

  it("completes a run gracefully and ignores later lifecycle bumps", async () => {
    const { service } = makeService({ now: c.now });
    await service.startRun({ runId: "r1", workspaceId: "ws1" });
    const done = await service.completeRun("r1", "completed");
    expect(done?.status).toBe("completed");
    expect(done?.endedAtMs).toBe(c.now());
    // already terminal → null no-ops
    expect(await service.completeRun("r1", "failed")).toBeNull();
    expect(await service.heartbeat("r1")).toBeNull();
    expect(await service.beginStep("r1", "x")).toBeNull();
  });

  it("throws when completing an untracked run", async () => {
    const { service } = makeService({ now: c.now });
    await expect(service.completeRun("ghost", "completed")).rejects.toBeInstanceOf(RunTimeoutError);
  });

  it("scopes reads to the owning workspace (IDOR boundary)", async () => {
    const { service } = makeService({ now: c.now });
    await service.startRun({ runId: "r1", workspaceId: "ws1" });
    expect(await service.getRun("ws1", "r1")).not.toBeNull();
    expect(await service.getRun("ws2", "r1")).toBeNull();
    expect(await service.listRuns("ws2")).toHaveLength(0);
  });
});

describe("RunTimeoutService.sweep", () => {
  let c: ReturnType<typeof clock>;
  beforeEach(() => {
    c = clock();
  });

  it("times out a run past its wall-clock budget, transitions it, and frees its resources", async () => {
    const releaser = new RecordingReleaser();
    const { service, store } = makeService({ now: c.now, releaser });
    await service.startRun({ runId: "r1", workspaceId: "ws1", sessionId: "s1", lockKey: "k1" });

    c.advance(RUN_MS); // reach the deadline
    const result = await service.sweep();

    expect(result.scanned).toBe(1);
    expect(result.timedOut).toHaveLength(1);
    const t = result.timedOut[0]!;
    expect(t.record.status).toBe("timed_out");
    expect(t.record.endedAtMs).toBe(c.now());
    expect(t.record.timeoutKind).toBe("run");
    expect(t.diagnostics.kind).toBe("run");
    expect(t.release.worktreeReleased).toBe(true);
    expect(t.release.lockReleased).toBe(true);

    // resource release was asked for with the run's handle
    expect(releaser.handles).toHaveLength(1);
    expect(releaser.handles[0]).toMatchObject({ runId: "r1", sessionId: "s1", lockKey: "k1", reason: "run" });

    // persisted state reflects the timeout + diagnostics
    const persisted = await store.get("ws1", "r1");
    expect(persisted?.status).toBe("timed_out");
    expect(persisted?.diagnostics?.message).toContain("budget");
  });

  it("times out a hung step while the run itself is still within budget", async () => {
    const releaser = new RecordingReleaser();
    const { service } = makeService({ now: c.now, releaser });
    await service.startRun({ runId: "r1", workspaceId: "ws1", sessionId: "s1" });
    c.advance(60_000);
    await service.beginStep("r1", "install-deps");
    c.advance(STEP_MS); // step over budget, run still fine

    const result = await service.sweep();
    expect(result.timedOut).toHaveLength(1);
    expect(result.timedOut[0]!.diagnostics.kind).toBe("step");
    expect(result.timedOut[0]!.record.timeoutKind).toBe("step");
    expect(releaser.handles[0]).toMatchObject({ reason: "step" });
  });

  it("leaves healthy runs untouched", async () => {
    const { service } = makeService({ now: c.now });
    await service.startRun({ runId: "r1", workspaceId: "ws1" });
    c.advance(RUN_MS - 1);
    const result = await service.sweep();
    expect(result.scanned).toBe(1);
    expect(result.timedOut).toHaveLength(0);
    expect((await service.getRun("ws1", "r1"))?.status).toBe("running");
  });

  it("is idempotent: a second sweep does not re-time-out an already timed-out run", async () => {
    const releaser = new RecordingReleaser();
    const { service } = makeService({ now: c.now, releaser });
    await service.startRun({ runId: "r1", workspaceId: "ws1", sessionId: "s1" });
    c.advance(RUN_MS);
    expect((await service.sweep()).timedOut).toHaveLength(1);
    // run is now terminal → no longer in the running set, nothing re-fires
    const second = await service.sweep();
    expect(second.scanned).toBe(0);
    expect(second.timedOut).toHaveLength(0);
    expect(releaser.handles).toHaveLength(1);
  });

  it("does nothing when the sweeper is disabled", async () => {
    const releaser = new RecordingReleaser();
    const disabled: RunTimeoutCaps = { ...ENABLED, enabled: false };
    const { service } = makeService({ now: c.now, caps: disabled, releaser });
    await service.startRun({ runId: "r1", workspaceId: "ws1" });
    c.advance(RUN_MS * 10);
    const result = await service.sweep();
    expect(result).toEqual({ scanned: 0, timedOut: [] });
    expect(releaser.handles).toHaveLength(0);
    expect((await service.getRun("ws1", "r1"))?.status).toBe("running");
  });

  it("times out multiple hung runs in one pass", async () => {
    const { service } = makeService({ now: c.now });
    await service.startRun({ runId: "r1", workspaceId: "ws1" });
    await service.startRun({ runId: "r2", workspaceId: "ws2" });
    await service.startRun({ runId: "r3", workspaceId: "ws1", runTimeoutMs: RUN_MS * 100 }); // long budget, healthy
    c.advance(RUN_MS);
    const result = await service.sweep();
    expect(result.scanned).toBe(3);
    expect(result.timedOut.map((t) => t.record.runId).sort()).toEqual(["r1", "r2"]);
  });
});

describe("createResourceReleaser", () => {
  const handle: ReleaseHandle = { runId: "r1", workspaceId: "ws1", sessionId: "s1", lockKey: "k1", reason: "run" };

  it("invokes the injected worktree + lock release functions", async () => {
    const released: string[] = [];
    const releaser = createResourceReleaser({
      releaseWorktree: async (id) => void released.push(`wt:${id}`),
      releaseLock: async (key) => void released.push(`lock:${key}`),
    });
    const outcome = await releaser.release(handle);
    expect(released).toEqual(["wt:s1", "lock:k1"]);
    expect(outcome).toEqual({ worktreeReleased: true, lockReleased: true, errors: [] });
  });

  it("skips resources the run never held", async () => {
    let calls = 0;
    const releaser = createResourceReleaser({
      releaseWorktree: async () => void calls++,
      releaseLock: async () => void calls++,
    });
    const outcome = await releaser.release({ ...handle, sessionId: null, lockKey: null });
    expect(calls).toBe(0);
    expect(outcome).toEqual({ worktreeReleased: false, lockReleased: false, errors: [] });
  });

  it("is best-effort: a failing worktree release is captured, lock release still runs", async () => {
    let lockReleased = false;
    const warnings: string[] = [];
    const releaser = createResourceReleaser({
      releaseWorktree: async () => {
        throw new Error("worktree busy");
      },
      releaseLock: async () => void (lockReleased = true),
      log: { warn: (_obj, msg) => warnings.push(msg) },
    });
    const outcome = await releaser.release(handle);
    expect(outcome.worktreeReleased).toBe(false);
    expect(outcome.lockReleased).toBe(true);
    expect(lockReleased).toBe(true);
    expect(outcome.errors[0]).toContain("worktree busy");
    expect(warnings[0]).toContain("worktree release failed");
  });

  it("never throws even when both releases fail", async () => {
    const releaser = createResourceReleaser({
      releaseWorktree: async () => {
        throw new Error("a");
      },
      releaseLock: async () => {
        throw new Error("b");
      },
    });
    const outcome = await releaser.release(handle);
    expect(outcome.errors).toHaveLength(2);
    expect(outcome.worktreeReleased).toBe(false);
    expect(outcome.lockReleased).toBe(false);
  });
});
