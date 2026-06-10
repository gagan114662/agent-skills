import { describe, it, expect } from "vitest";
import { decideRevival, type RevivalDecisionInput } from "../../src/watchdog/decide.js";
import type { WatchdogThresholds } from "../../src/watchdog/types.js";

const thresholds: WatchdogThresholds = {
  staleCutoffMs: 300_000,
  maxRevivalsPerWindow: 3,
  windowMs: 3_600_000,
  backoffMs: 30_000,
};

/** A stale, retryable, under-limit, past-backoff, budget-OK input — the REVIVE baseline. */
function input(over: Partial<RevivalDecisionInput> = {}): RevivalDecisionInput {
  return {
    staleForMs: 600_000, // 10m stale, well past the 5m cutoff
    revivalsInWindow: 0,
    msSinceLastRevival: Number.POSITIVE_INFINITY,
    retryable: true,
    killSwitch: false,
    budgetExhausted: false,
    thresholds,
    ...over,
  };
}

describe("decideRevival (the pure bounded-restart gate)", () => {
  it("REVIVEs a stale, retryable session under the limit and past backoff", () => {
    const d = decideRevival(input());
    expect(d.action).toBe("revive");
    expect(d.reason).toBe("stale_session");
  });

  // Order matters: hard stops first.
  it("NOOPs (kill switch) above everything else — even a long-stale session", () => {
    expect(decideRevival(input({ killSwitch: true })).action).toBe("noop");
    expect(decideRevival(input({ killSwitch: true })).reason).toBe("kill_switch");
  });

  it("NOOPs when the session is not yet stale", () => {
    const d = decideRevival(input({ staleForMs: 1000 }));
    expect(d.action).toBe("noop");
    expect(d.reason).toBe("not_stale");
  });

  it("ESCALATEs a non-retryable failure on first detection (never infinite-retry a broken session)", () => {
    const d = decideRevival(input({ retryable: false }));
    expect(d.action).toBe("escalate");
    expect(d.reason).toBe("non_retryable_failure");
  });

  it("ESCALATEs once the per-window revival limit is reached (repeated death → a human)", () => {
    const d = decideRevival(input({ revivalsInWindow: 3 }));
    expect(d.action).toBe("escalate");
    expect(d.reason).toBe("revival_limit");
  });

  it("ESCALATEs when the dollar budget is exhausted (no more spend on revivals)", () => {
    const d = decideRevival(input({ budgetExhausted: true }));
    expect(d.action).toBe("escalate");
    expect(d.reason).toBe("budget_exhausted");
  });

  it("WAITs when stale but still inside the backoff window (don't hammer)", () => {
    const d = decideRevival(input({ msSinceLastRevival: 10_000 }));
    expect(d.action).toBe("wait");
    expect(d.reason).toBe("backoff");
  });

  it("prioritises the revival limit over the budget reason (repeated death wins)", () => {
    const d = decideRevival(input({ revivalsInWindow: 5, budgetExhausted: true }));
    expect(d.action).toBe("escalate");
    expect(d.reason).toBe("revival_limit");
  });
});
