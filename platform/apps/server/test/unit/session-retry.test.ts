import { describe, it, expect } from "vitest";
import { decideSpawnRetry, DEFAULT_SPAWN_RETRY_BACKOFF } from "../../src/runtime/session-retry.js";

describe("decideSpawnRetry (#436 — safe spawn-launch retry)", () => {
  it("never retries when maxAttempts <= 1 (default OFF = today's behavior)", () => {
    expect(decideSpawnRetry(1, 1)).toEqual({ retry: false, backoffMs: 0 });
    expect(decideSpawnRetry(1, 0)).toEqual({ retry: false, backoffMs: 0 });
  });

  it("retries with exponential backoff while attempts remain", () => {
    const d1 = decideSpawnRetry(1, 3);
    expect(d1.retry).toBe(true);
    expect(d1.backoffMs).toBeGreaterThan(0);
    const d2 = decideSpawnRetry(2, 3);
    expect(d2.retry).toBe(true);
    expect(d2.backoffMs).toBeGreaterThan(d1.backoffMs); // exponential growth between attempts
  });

  it("stops at the last attempt (bounded — never loops forever)", () => {
    expect(decideSpawnRetry(3, 3).retry).toBe(false);
    expect(decideSpawnRetry(4, 3).retry).toBe(false);
  });

  it("caps the backoff (a misconfigured factor can't produce an unbounded wait)", () => {
    expect(decideSpawnRetry(10, 99).backoffMs).toBeLessThanOrEqual(DEFAULT_SPAWN_RETRY_BACKOFF.capMs);
  });

  it("guards garbage inputs (non-finite attempt/max collapse to no-retry)", () => {
    expect(decideSpawnRetry(NaN, 3).retry).toBe(true); // attempt→1, still has attempts
    expect(decideSpawnRetry(1, NaN).retry).toBe(false); // max→1 ⇒ off
  });
});
