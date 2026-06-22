import { describe, it, expect } from "vitest";
import { buildReplayPlan, isReplayable, verifyReproduction } from "../../src/run-replay/replay.js";
import type { CapturedRun, RunOutcome } from "../../src/run-replay/types.js";

function capture(over: Partial<CapturedRun> = {}): CapturedRun {
  return {
    runId: "r1",
    workspaceId: "ws1",
    status: "failed",
    inputs: { prompt: "p", seed: 7, config: { model: "m" }, env: {} },
    inputsFingerprint: "fp-1",
    replayOf: null,
    capturedAtMs: 100,
    endedAtMs: 200,
    outcome: { status: "failed", failureSignature: "TypeError: x is undefined", outputFingerprint: "out-1" },
    ...over,
  };
}

const FAIL: RunOutcome = { status: "failed", failureSignature: "TypeError: x is undefined", outputFingerprint: "o1" };

describe("isReplayable", () => {
  it("accepts a finished, failed run", () => {
    expect(isReplayable(capture())).toEqual({ ok: true });
  });

  it("rejects a still-running run", () => {
    const r = isReplayable(capture({ status: "running", outcome: null, endedAtMs: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("has not finished");
  });

  it("rejects a completed (non-failed) run — only failures are reproduced", () => {
    const r = isReplayable(
      capture({ status: "completed", outcome: { status: "completed", failureSignature: null, outputFingerprint: "o" } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("did not fail");
  });
});

describe("buildReplayPlan", () => {
  it("carries the exact inputs/seed/config, the original id, and the expected outcome", () => {
    const plan = buildReplayPlan(capture());
    expect(plan.originalRunId).toBe("r1");
    expect(plan.workspaceId).toBe("ws1");
    expect(plan.inputs).toEqual({ prompt: "p", seed: 7, config: { model: "m" }, env: {} });
    expect(plan.inputsFingerprint).toBe("fp-1");
    expect(plan.expectedOutcome.failureSignature).toBe("TypeError: x is undefined");
  });

  it("throws when the capture is not replayable", () => {
    expect(() => buildReplayPlan(capture({ status: "running", outcome: null }))).toThrow();
  });
});

describe("verifyReproduction", () => {
  it("reports `reproduced` when the replay fails the same way", () => {
    const v = verifyReproduction(FAIL, { ...FAIL });
    expect(v.kind).toBe("reproduced");
    expect(v.reproduced).toBe(true);
    expect(v.message).toContain("reproduced the failure");
  });

  it("reports `diverged` when the replay succeeds", () => {
    const v = verifyReproduction(FAIL, { status: "completed", failureSignature: null, outputFingerprint: "o2" });
    expect(v.kind).toBe("diverged");
    expect(v.reproduced).toBe(false);
    expect(v.message).toContain("completed successfully");
  });

  it("reports `diverged` when the replay fails differently", () => {
    const v = verifyReproduction(FAIL, { status: "failed", failureSignature: "RangeError: oops", outputFingerprint: "o3" });
    expect(v.kind).toBe("diverged");
    expect(v.reproduced).toBe(false);
    expect(v.message).toContain("failed differently");
  });

  it("reports `not_a_failure` when the original did not fail", () => {
    const ok: RunOutcome = { status: "completed", failureSignature: null, outputFingerprint: "o" };
    const v = verifyReproduction(ok, ok);
    expect(v.kind).toBe("not_a_failure");
    expect(v.reproduced).toBe(false);
  });
});
