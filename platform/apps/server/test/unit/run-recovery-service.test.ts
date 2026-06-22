import { describe, it, expect, beforeEach } from "vitest";
import { RunRecoveryService, RunRecoveryError } from "../../src/run-recovery/service.js";
import { InMemoryRunRecoveryStore } from "../../src/run-recovery/store.js";
import {
  createRunReconciler,
  type ReconcileHandle,
  type ReconcileOutcome,
  type RunReconciler,
} from "../../src/run-recovery/reconcile.js";
import type { RunRecoveryCaps } from "../../src/run-recovery/caps.js";

const ENABLED: RunRecoveryCaps = { enabled: true, maxResumeAttempts: 3 };
const LIVE = "instance-live";
const DEAD = "instance-dead";

/** A controllable epoch-ms clock. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

/** A reconciler that records every handle it was asked to reconcile/release. */
class RecordingReconciler implements RunReconciler {
  reconciled: ReconcileHandle[] = [];
  released: ReconcileHandle[] = [];
  async reconcile(handle: ReconcileHandle): Promise<ReconcileOutcome> {
    this.reconciled.push(handle);
    return { worktreeReconciled: handle.sessionId !== null, lockReconciled: handle.lockKey !== null, errors: [] };
  }
  async release(handle: ReconcileHandle): Promise<ReconcileOutcome> {
    this.released.push(handle);
    return { worktreeReconciled: handle.sessionId !== null, lockReconciled: handle.lockKey !== null, errors: [] };
  }
}

function makeService(opts: {
  caps?: RunRecoveryCaps;
  reconciler?: RunReconciler;
  instanceId?: string;
  now: () => number;
}) {
  const store = new InMemoryRunRecoveryStore();
  const service = new RunRecoveryService({
    store,
    instanceId: opts.instanceId ?? LIVE,
    reconciler: opts.reconciler,
    caps: opts.caps ?? ENABLED,
    now: opts.now,
  });
  return { store, service };
}

describe("RunRecoveryService lifecycle", () => {
  let c: ReturnType<typeof clock>;
  beforeEach(() => {
    c = clock();
  });

  it("records a run stamped with this instance, running and not-yet-resumable", async () => {
    const { service } = makeService({ now: c.now });
    const rec = await service.startRun({ runId: "r1", workspaceId: "ws1", sessionId: "s1", lockKey: "k1" });
    expect(rec.status).toBe("running");
    expect(rec.ownerInstanceId).toBe(LIVE);
    expect(rec.resumable).toBe(false);
    expect(rec.startedAtMs).toBe(c.now());
    expect(rec.lastHeartbeatAtMs).toBe(c.now());
    expect(rec.resumeAttempts).toBe(0);
  });

  it("honors a resumable run started with the flag set", async () => {
    const { service } = makeService({ now: c.now });
    const rec = await service.startRun({ runId: "r1", workspaceId: "ws1", resumable: true });
    expect(rec.resumable).toBe(true);
  });

  it("flips the resumable flag and heartbeats", async () => {
    const { service } = makeService({ now: c.now });
    await service.startRun({ runId: "r1", workspaceId: "ws1" });
    const r = await service.setResumable("r1", true);
    expect(r?.resumable).toBe(true);
    c.advance(50);
    const beat = await service.heartbeat("r1");
    expect(beat?.lastHeartbeatAtMs).toBe(c.now());
  });

  it("completes a run gracefully and ignores later lifecycle bumps", async () => {
    const { service } = makeService({ now: c.now });
    await service.startRun({ runId: "r1", workspaceId: "ws1" });
    const done = await service.completeRun("r1", "completed");
    expect(done?.status).toBe("completed");
    expect(done?.endedAtMs).toBe(c.now());
    expect(await service.completeRun("r1", "failed")).toBeNull();
    expect(await service.heartbeat("r1")).toBeNull();
    expect(await service.setResumable("r1", true)).toBeNull();
  });

  it("throws when completing an untracked run", async () => {
    const { service } = makeService({ now: c.now });
    await expect(service.completeRun("ghost", "completed")).rejects.toBeInstanceOf(RunRecoveryError);
  });

  it("scopes reads to the owning workspace (IDOR boundary)", async () => {
    const { service } = makeService({ now: c.now });
    await service.startRun({ runId: "r1", workspaceId: "ws1" });
    expect(await service.getRun("ws1", "r1")).not.toBeNull();
    expect(await service.getRun("ws2", "r1")).toBeNull();
    expect(await service.listRuns("ws2")).toHaveLength(0);
  });
});

describe("RunRecoveryService.recover", () => {
  let c: ReturnType<typeof clock>;
  beforeEach(() => {
    c = clock();
  });

  /** Seed an orphaned run (owned by a dead instance) directly into the store. */
  async function seedOrphan(
    store: InMemoryRunRecoveryStore,
    over: { runId: string; workspaceId?: string; resumable?: boolean; resumeAttempts?: number; sessionId?: string | null; lockKey?: string | null },
  ) {
    return store.insert({
      runId: over.runId,
      workspaceId: over.workspaceId ?? "ws1",
      sessionId: "sessionId" in over ? (over.sessionId ?? null) : "s1",
      lockKey: "lockKey" in over ? (over.lockKey ?? null) : "k1",
      ownerInstanceId: DEAD,
      status: "running",
      resumable: over.resumable ?? true,
      startedAtMs: 10,
      lastHeartbeatAtMs: 10,
      resumeAttempts: over.resumeAttempts ?? 0,
      lastRecoveredAtMs: null,
      endedAtMs: null,
      failureReason: null,
      recovery: null,
    });
  }

  it("resumes a resumable orphan: re-owns it, bumps attempts, reconciles its worktree/lock", async () => {
    const reconciler = new RecordingReconciler();
    const { service, store } = makeService({ now: c.now, reconciler });
    await seedOrphan(store, { runId: "r1" });

    const result = await service.recover();

    expect(result.scanned).toBe(1);
    expect(result.resumed).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    const r = result.resumed[0]!;
    expect(r.record.status).toBe("running");
    expect(r.record.ownerInstanceId).toBe(LIVE); // re-owned under the live instance
    expect(r.record.resumeAttempts).toBe(1);
    expect(r.record.lastRecoveredAtMs).toBe(c.now());
    expect(r.diagnostics.action).toBe("resume");
    expect(r.reconcile.worktreeReconciled).toBe(true);
    expect(r.reconcile.lockReconciled).toBe(true);

    // reconcile (not release) was asked for, with the resume action
    expect(reconciler.reconciled).toHaveLength(1);
    expect(reconciler.reconciled[0]).toMatchObject({ runId: "r1", sessionId: "s1", lockKey: "k1", action: "resume" });
    expect(reconciler.released).toHaveLength(0);

    // persisted state reflects the resume + diagnostics
    const persisted = await store.get("ws1", "r1");
    expect(persisted?.ownerInstanceId).toBe(LIVE);
    expect(persisted?.recovery?.message).toContain("resumed");
  });

  it("fails a non-resumable orphan with a reason and releases its worktree/lock", async () => {
    const reconciler = new RecordingReconciler();
    const { service, store } = makeService({ now: c.now, reconciler });
    await seedOrphan(store, { runId: "r1", resumable: false });

    const result = await service.recover();

    expect(result.resumed).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    const f = result.failed[0]!;
    expect(f.record.status).toBe("failed");
    expect(f.record.endedAtMs).toBe(c.now());
    expect(f.record.failureReason).toBe("not_resumable");
    expect(f.diagnostics.action).toBe("fail");
    expect(f.release.worktreeReconciled).toBe(true);
    expect(f.release.lockReconciled).toBe(true);

    // release (not reconcile) was asked for, with the fail action
    expect(reconciler.released[0]).toMatchObject({ runId: "r1", action: "fail" });
    expect(reconciler.reconciled).toHaveLength(0);

    const persisted = await store.get("ws1", "r1");
    expect(persisted?.status).toBe("failed");
    expect(persisted?.recovery?.reason).toBe("not_resumable");
  });

  it("fails a resumable orphan that has exhausted its resume budget", async () => {
    const reconciler = new RecordingReconciler();
    const { service, store } = makeService({ now: c.now, reconciler });
    await seedOrphan(store, { runId: "r1", resumeAttempts: 3 });

    const result = await service.recover();
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.record.failureReason).toBe("max_attempts_exhausted");
    expect(reconciler.released[0]).toMatchObject({ action: "fail" });
  });

  it("leaves a run the live instance still owns untouched (not orphaned)", async () => {
    const { service, store } = makeService({ now: c.now });
    await service.startRun({ runId: "r1", workspaceId: "ws1" }); // owned by LIVE
    const result = await service.recover();
    expect(result.scanned).toBe(0);
    expect(result.resumed).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect((await store.get("ws1", "r1"))?.status).toBe("running");
  });

  it("is idempotent: a second pass does not re-recover an already re-owned run", async () => {
    const reconciler = new RecordingReconciler();
    const { service, store } = makeService({ now: c.now, reconciler });
    await seedOrphan(store, { runId: "r1" });

    const first = await service.recover();
    expect(first.resumed).toHaveLength(1);

    // r1 is now owned by LIVE → no longer orphaned
    const second = await service.recover();
    expect(second.scanned).toBe(0);
    expect(second.resumed).toHaveLength(0);
    expect(reconciler.reconciled).toHaveLength(1);
  });

  it("recovers a mixed batch in one pass: resumes some, fails others", async () => {
    const { service, store } = makeService({ now: c.now });
    await seedOrphan(store, { runId: "r1", resumable: true });
    await seedOrphan(store, { runId: "r2", resumable: false });
    await seedOrphan(store, { runId: "r3", resumable: true, resumeAttempts: 3 }); // budget exhausted → fail
    await service.startRun({ runId: "r4", workspaceId: "ws1" }); // live-owned → skipped

    const result = await service.recover();
    expect(result.scanned).toBe(3);
    expect(result.resumed.map((r) => r.record.runId)).toEqual(["r1"]);
    expect(result.failed.map((f) => f.record.runId).sort()).toEqual(["r2", "r3"]);
    expect((await store.get("ws1", "r4"))?.status).toBe("running");
  });

  it("does nothing when recovery is disabled", async () => {
    const reconciler = new RecordingReconciler();
    const disabled: RunRecoveryCaps = { ...ENABLED, enabled: false };
    const { service, store } = makeService({ now: c.now, caps: disabled, reconciler });
    await seedOrphan(store, { runId: "r1" });
    const result = await service.recover();
    expect(result).toEqual({ scanned: 0, resumed: [], failed: [] });
    expect(reconciler.reconciled).toHaveLength(0);
    expect(reconciler.released).toHaveLength(0);
    expect((await store.get("ws1", "r1"))?.status).toBe("running");
  });

  it("recovers a run that holds no worktree/lock without error (nothing to reconcile)", async () => {
    const reconciler = new RecordingReconciler();
    const { service, store } = makeService({ now: c.now, reconciler });
    await seedOrphan(store, { runId: "r1", sessionId: null, lockKey: null });
    const result = await service.recover();
    expect(result.resumed).toHaveLength(1);
    expect(result.resumed[0]!.reconcile).toEqual({ worktreeReconciled: false, lockReconciled: false, errors: [] });
  });
});

describe("createRunReconciler", () => {
  const resumeHandle: ReconcileHandle = { runId: "r1", workspaceId: "ws1", sessionId: "s1", lockKey: "k1", action: "resume" };
  const failHandle: ReconcileHandle = { ...resumeHandle, action: "fail" };

  it("reconcile() ensures the worktree and re-acquires the lock", async () => {
    const calls: string[] = [];
    const reconciler = createRunReconciler({
      ensureWorktree: async (id) => void calls.push(`ensure:${id}`),
      acquireLock: async (key) => void calls.push(`acquire:${key}`),
    });
    const outcome = await reconciler.reconcile(resumeHandle);
    expect(calls).toEqual(["ensure:s1", "acquire:k1"]);
    expect(outcome).toEqual({ worktreeReconciled: true, lockReconciled: true, errors: [] });
  });

  it("release() releases the worktree and the lock", async () => {
    const calls: string[] = [];
    const reconciler = createRunReconciler({
      releaseWorktree: async (id) => void calls.push(`relwt:${id}`),
      releaseLock: async (key) => void calls.push(`rellock:${key}`),
    });
    const outcome = await reconciler.release(failHandle);
    expect(calls).toEqual(["relwt:s1", "rellock:k1"]);
    expect(outcome).toEqual({ worktreeReconciled: true, lockReconciled: true, errors: [] });
  });

  it("skips resources the run never held", async () => {
    let calls = 0;
    const reconciler = createRunReconciler({
      ensureWorktree: async () => void calls++,
      acquireLock: async () => void calls++,
    });
    const outcome = await reconciler.reconcile({ ...resumeHandle, sessionId: null, lockKey: null });
    expect(calls).toBe(0);
    expect(outcome).toEqual({ worktreeReconciled: false, lockReconciled: false, errors: [] });
  });

  it("is best-effort: a failing worktree step is captured, the lock step still runs", async () => {
    let lockDone = false;
    const warnings: string[] = [];
    const reconciler = createRunReconciler({
      ensureWorktree: async () => {
        throw new Error("index.lock present");
      },
      acquireLock: async () => void (lockDone = true),
      log: { warn: (_obj, msg) => warnings.push(msg) },
    });
    const outcome = await reconciler.reconcile(resumeHandle);
    expect(outcome.worktreeReconciled).toBe(false);
    expect(outcome.lockReconciled).toBe(true);
    expect(lockDone).toBe(true);
    expect(outcome.errors[0]).toContain("index.lock present");
    expect(warnings[0]).toContain("worktree reconcile failed");
  });

  it("never throws even when both steps fail", async () => {
    const reconciler = createRunReconciler({
      releaseWorktree: async () => {
        throw new Error("a");
      },
      releaseLock: async () => {
        throw new Error("b");
      },
    });
    const outcome = await reconciler.release(failHandle);
    expect(outcome.errors).toHaveLength(2);
    expect(outcome.worktreeReconciled).toBe(false);
    expect(outcome.lockReconciled).toBe(false);
  });
});
