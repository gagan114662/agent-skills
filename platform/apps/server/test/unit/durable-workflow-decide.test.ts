import { describe, it, expect } from "vitest";
import { decideStep, type StepDecisionInput } from "../../src/durable-workflow/decide.js";
import { nextBackoffMs } from "../../src/durable-workflow/backoff.js";

/** A runnable baseline: running, attempts under cap, before deadline, no backoff cursor, reversible. */
function input(over: Partial<StepDecisionInput> = {}): StepDecisionInput {
  return {
    status: "running",
    attempts: 0,
    maxAttempts: 5,
    nowMs: 1_000,
    deadlineAtMs: 100_000,
    nextAttemptAtMs: null,
    requiresApproval: false,
    approvalRequestId: null,
    ...over,
  };
}

describe("decideStep (the pure durable-step gate)", () => {
  it("RUNs a runnable step", () => {
    expect(decideStep(input()).kind).toBe("run");
  });

  // Priority: terminal first.
  it("is DONE (idempotent) for a terminal run — even one that is also past its deadline", () => {
    expect(decideStep(input({ status: "succeeded", nowMs: 999_999 })).kind).toBe("done");
    expect(decideStep(input({ status: "failed" })).kind).toBe("done");
    expect(decideStep(input({ status: "canceled" })).kind).toBe("done");
  });

  it("TIMEOUTs once now >= deadline (the no-hang guarantee) — beats exhaustion and the gate", () => {
    const d = decideStep(input({ nowMs: 100_000, attempts: 99, requiresApproval: true }));
    expect(d.kind).toBe("timeout");
  });

  it("is EXHAUSTED once attempts reach maxAttempts (bounded retries)", () => {
    expect(decideStep(input({ attempts: 5, maxAttempts: 5 })).kind).toBe("exhausted");
  });

  it("GATEs an irreversible step with no approval (the structural #13 always-gate)", () => {
    expect(decideStep(input({ requiresApproval: true, approvalRequestId: null })).kind).toBe("gate");
  });

  it("RUNs an irreversible step once an approval id is present", () => {
    expect(
      decideStep(input({ requiresApproval: true, approvalRequestId: "appr-1" })).kind,
    ).toBe("run");
  });

  it("WAITs while inside the backoff window, then RUNs once the cursor elapses", () => {
    const waiting = decideStep(input({ status: "suspended", nowMs: 5_000, nextAttemptAtMs: 8_000 }));
    expect(waiting.kind).toBe("wait");
    if (waiting.kind === "wait") expect(waiting.untilMs).toBe(8_000);
    expect(decideStep(input({ status: "suspended", nowMs: 8_000, nextAttemptAtMs: 8_000 })).kind).toBe(
      "run",
    );
  });
});

describe("nextBackoffMs (pure exponential backoff)", () => {
  const policy = { baseMs: 1000, factor: 2, capMs: 10_000, maxAttempts: 10 };

  it("grows exponentially: base * factor^attempt", () => {
    expect(nextBackoffMs(0, policy)).toBe(1000);
    expect(nextBackoffMs(1, policy)).toBe(2000);
    expect(nextBackoffMs(2, policy)).toBe(4000);
    expect(nextBackoffMs(3, policy)).toBe(8000);
  });

  it("caps at capMs", () => {
    expect(nextBackoffMs(4, policy)).toBe(10_000); // 16000 capped
    expect(nextBackoffMs(50, policy)).toBe(10_000); // would overflow; cap holds
  });

  it("is defensive against misconfig (never negative / NaN)", () => {
    expect(nextBackoffMs(-3, policy)).toBe(1000);
    expect(nextBackoffMs(2, { baseMs: 0, factor: 0, capMs: 0, maxAttempts: 1 })).toBe(0);
  });
});
