import { describe, it, expect } from "vitest";
import { decideRecovery, type RecoveryContext } from "../../src/run-recovery/decide.js";
import type { RunRecord } from "../../src/run-recovery/types.js";

const LIVE = "instance-live";
const DEAD = "instance-dead";

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "r1",
    workspaceId: "ws1",
    sessionId: "s1",
    lockKey: "k1",
    ownerInstanceId: DEAD,
    status: "running",
    resumable: true,
    startedAtMs: 1_000,
    lastHeartbeatAtMs: 1_000,
    resumeAttempts: 0,
    lastRecoveredAtMs: null,
    endedAtMs: null,
    failureReason: null,
    recovery: null,
    ...overrides,
  };
}

const ctx: RecoveryContext = { instanceId: LIVE, nowMs: 5_000, maxResumeAttempts: 3 };

describe("decideRecovery", () => {
  it("skips a run already owned by the live instance (not orphaned)", () => {
    const d = decideRecovery(record({ ownerInstanceId: LIVE }), ctx);
    expect(d).toEqual({ kind: "skip", reason: "owned" });
  });

  it("skips a terminal run regardless of owner", () => {
    expect(decideRecovery(record({ status: "completed" }), ctx)).toEqual({ kind: "skip", reason: "terminal" });
    expect(decideRecovery(record({ status: "failed" }), ctx)).toEqual({ kind: "skip", reason: "terminal" });
  });

  it("resumes an orphaned, resumable run within the attempt budget", () => {
    const d = decideRecovery(record({ resumeAttempts: 1 }), ctx);
    expect(d.kind).toBe("resume");
    if (d.kind !== "resume") throw new Error("unreachable");
    expect(d.diagnostics).toMatchObject({
      action: "resume",
      reason: "resumable",
      orphanedFromInstanceId: DEAD,
      detectedAtMs: 5_000,
      resumeAttempt: 2, // post-increment
    });
    expect(d.diagnostics.message).toContain("attempt 2");
  });

  it("fails an orphaned run that was never resumable", () => {
    const d = decideRecovery(record({ resumable: false }), ctx);
    expect(d.kind).toBe("fail");
    if (d.kind !== "fail") throw new Error("unreachable");
    expect(d.reason).toBe("not_resumable");
    expect(d.diagnostics).toMatchObject({ action: "fail", reason: "not_resumable" });
    expect(d.diagnostics.message).toContain("no resumable checkpoint");
  });

  it("fails a resumable run that has exhausted its resume budget (crash-loop guard)", () => {
    const d = decideRecovery(record({ resumeAttempts: 3 }), ctx);
    expect(d.kind).toBe("fail");
    if (d.kind !== "fail") throw new Error("unreachable");
    expect(d.reason).toBe("max_attempts_exhausted");
    expect(d.diagnostics.message).toContain("resume budget 3 exhausted");
  });

  it("the budget boundary: attempts == budget fails, attempts < budget resumes", () => {
    expect(decideRecovery(record({ resumeAttempts: 2 }), ctx).kind).toBe("resume");
    expect(decideRecovery(record({ resumeAttempts: 3 }), ctx).kind).toBe("fail");
  });

  it("a zero budget always fails an orphan (never resume)", () => {
    const d = decideRecovery(record({ resumeAttempts: 0 }), { ...ctx, maxResumeAttempts: 0 });
    expect(d.kind).toBe("fail");
    if (d.kind !== "fail") throw new Error("unreachable");
    expect(d.reason).toBe("max_attempts_exhausted");
  });

  it("non-resumable outranks an exhausted budget in the reason", () => {
    // both conditions hold; not_resumable is reported first (the more fundamental reason)
    const d = decideRecovery(record({ resumable: false, resumeAttempts: 99 }), ctx);
    expect(d.kind).toBe("fail");
    if (d.kind !== "fail") throw new Error("unreachable");
    expect(d.reason).toBe("not_resumable");
  });
});
