import { describe, it, expect } from "vitest";
import { decideTimeout, formatDuration } from "../../src/run-timeout/decide.js";
import type { RunTimeoutRecord } from "../../src/run-timeout/types.js";

const RUN_MS = 30 * 60 * 1000; // 30m
const STEP_MS = 5 * 60 * 1000; // 5m
const START = 1_000_000;

function makeRecord(overrides: Partial<RunTimeoutRecord> = {}): RunTimeoutRecord {
  return {
    runId: "run-1",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    lockKey: "lock-1",
    status: "running",
    startedAtMs: START,
    deadlineAtMs: START + RUN_MS,
    runTimeoutMs: RUN_MS,
    stepTimeoutMs: STEP_MS,
    stepName: null,
    stepStartedAtMs: null,
    lastHeartbeatAtMs: START,
    endedAtMs: null,
    timeoutKind: null,
    diagnostics: null,
    ...overrides,
  };
}

describe("formatDuration", () => {
  it("renders compact human durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s"); // sub-second floors to 0s
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(90_000)).toBe("1m30s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(90_061_000)).toBe("1d1h1m1s");
  });

  it("never produces a negative duration", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});

describe("decideTimeout", () => {
  it("returns ok for a fresh run within both budgets", () => {
    expect(decideTimeout(makeRecord(), START + 10).kind).toBe("ok");
  });

  it("is a no-op for any terminal run (idempotent — never re-fires)", () => {
    for (const status of ["completed", "failed", "timed_out"] as const) {
      const rec = makeRecord({ status });
      // way past both deadlines, but already terminal:
      expect(decideTimeout(rec, START + RUN_MS + 10).kind).toBe("ok");
    }
  });

  it("fires a run timeout once the wall-clock budget is reached (>= is inclusive)", () => {
    const rec = makeRecord();
    expect(decideTimeout(rec, START + RUN_MS - 1).kind).toBe("ok");
    const decision = decideTimeout(rec, START + RUN_MS);
    expect(decision.kind).toBe("run_timeout");
    if (decision.kind !== "run_timeout") throw new Error("unreachable");
    expect(decision.diagnostics.kind).toBe("run");
    expect(decision.diagnostics.runElapsedMs).toBe(RUN_MS);
    expect(decision.diagnostics.runTimeoutMs).toBe(RUN_MS);
    expect(decision.diagnostics.detectedAtMs).toBe(START + RUN_MS);
    expect(decision.diagnostics.message).toContain("30m");
  });

  it("fires a step timeout when an in-flight step exceeds its budget (run still within budget)", () => {
    const stepStart = START + 60_000;
    const rec = makeRecord({ stepName: "compile", stepStartedAtMs: stepStart, lastHeartbeatAtMs: stepStart });
    // step just under budget
    expect(decideTimeout(rec, stepStart + STEP_MS - 1).kind).toBe("ok");
    const decision = decideTimeout(rec, stepStart + STEP_MS);
    expect(decision.kind).toBe("step_timeout");
    if (decision.kind !== "step_timeout") throw new Error("unreachable");
    expect(decision.diagnostics.kind).toBe("step");
    expect(decision.diagnostics.step).toEqual({ name: "compile", elapsedMs: STEP_MS, timeoutMs: STEP_MS });
    expect(decision.diagnostics.message).toContain("compile");
  });

  it("does not apply the step budget when no step is in flight", () => {
    // No step → only the run budget can fire. A long-idle run between steps is fine until the run budget.
    const rec = makeRecord({ stepName: null, stepStartedAtMs: null });
    expect(decideTimeout(rec, START + STEP_MS * 5).kind).toBe("ok");
  });

  it("prefers the run timeout when both deadlines have passed", () => {
    // run budget breached AND a step long over its own budget → reported as a run timeout (more useful).
    const rec = makeRecord({
      stepName: "deploy",
      stepStartedAtMs: START + 100,
      lastHeartbeatAtMs: START + 100,
    });
    const decision = decideTimeout(rec, START + RUN_MS + STEP_MS);
    expect(decision.kind).toBe("run_timeout");
    if (decision.kind !== "run_timeout") throw new Error("unreachable");
    // run diagnostics still carry the step detail for context
    expect(decision.diagnostics.step?.name).toBe("deploy");
  });

  it("reports idle time since the last heartbeat in diagnostics", () => {
    const rec = makeRecord({ lastHeartbeatAtMs: START + 200 });
    const decision = decideTimeout(rec, START + RUN_MS);
    if (decision.kind !== "run_timeout") throw new Error("expected run_timeout");
    expect(decision.diagnostics.idleMs).toBe(RUN_MS - 200);
  });

  it("clamps a clock skew (now before start) to non-negative elapsed", () => {
    const rec = makeRecord();
    const decision = decideTimeout(rec, START - 5_000);
    expect(decision.kind).toBe("ok");
  });
});
