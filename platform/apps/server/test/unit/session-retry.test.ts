import { describe, it, expect } from "vitest";
import {
  decideSessionRetry,
  decideSpawnRetry,
  DEFAULT_SESSION_RETRY_BACKOFF,
} from "../../src/runtime/session-retry.js";
import type { SessionRetryInput } from "../../src/runtime/session-retry.js";

/** A clean pre-progress null-exit death — the ONE retryable shape — with retry enabled by default. */
const deadPreProgress = (over: Partial<SessionRetryInput> = {}): SessionRetryInput => ({
  attempt: 1,
  maxAttempts: 3,
  status: "failed",
  exitCode: null,
  sawOutput: false,
  sawHeartbeat: false,
  ...over,
});

describe("decideSessionRetry (#436 — idempotency-guarded bounded retry)", () => {
  it("is OFF by default (maxAttempts <= 1 ⇒ one attempt, today's behavior)", () => {
    expect(decideSessionRetry(deadPreProgress({ maxAttempts: 1 }))).toEqual({
      retry: false,
      backoffMs: 0,
      reason: "off",
    });
    expect(decideSessionRetry(deadPreProgress({ maxAttempts: 0 })).reason).toBe("off");
  });

  it("retries a clean pre-progress null-exit death with exponential backoff", () => {
    const d1 = decideSessionRetry(deadPreProgress({ attempt: 1 }));
    expect(d1).toMatchObject({ retry: true, reason: "retry" });
    expect(d1.backoffMs).toBeGreaterThan(0);
    const d2 = decideSessionRetry(deadPreProgress({ attempt: 2 }));
    expect(d2.retry).toBe(true);
    expect(d2.backoffMs).toBeGreaterThan(d1.backoffMs); // grows between attempts
  });

  it("NEVER retries once any output was seen (idempotency: the attempt may have acted)", () => {
    const d = decideSessionRetry(deadPreProgress({ sawOutput: true }));
    expect(d).toEqual({ retry: false, backoffMs: 0, reason: "progress" });
  });

  it("NEVER retries once a heartbeat fired (same idempotency guard)", () => {
    const d = decideSessionRetry(deadPreProgress({ sawHeartbeat: true }));
    expect(d).toEqual({ retry: false, backoffMs: 0, reason: "progress" });
  });

  it("does NOT retry a non-null exit code (a real run that produced a real failure)", () => {
    expect(decideSessionRetry(deadPreProgress({ exitCode: 1 })).reason).toBe("non-retryable");
    expect(decideSessionRetry(deadPreProgress({ exitCode: 0, status: "completed" })).reason).toBe(
      "non-retryable",
    );
  });

  it("does NOT retry a timeout/idle reap or an intentional cancel (#436 non-retryable classes)", () => {
    expect(decideSessionRetry(deadPreProgress({ status: "timeout" })).reason).toBe("non-retryable");
    expect(decideSessionRetry(deadPreProgress({ status: "idle_reaped" })).reason).toBe("non-retryable");
    expect(decideSessionRetry(deadPreProgress({ status: "canceled" })).reason).toBe("non-retryable");
  });

  it("is bounded — never loops past the attempt ceiling", () => {
    expect(decideSessionRetry(deadPreProgress({ attempt: 3, maxAttempts: 3 })).reason).toBe("exhausted");
    expect(decideSessionRetry(deadPreProgress({ attempt: 4, maxAttempts: 3 })).retry).toBe(false);
  });

  it("caps the backoff (a misconfigured factor can't produce an unbounded wait)", () => {
    const d = decideSessionRetry(deadPreProgress({ attempt: 10, maxAttempts: 99 }));
    expect(d.backoffMs).toBeLessThanOrEqual(DEFAULT_SESSION_RETRY_BACKOFF.capMs);
  });

  it("guards garbage inputs (non-finite attempt/max collapse safely)", () => {
    expect(decideSessionRetry(deadPreProgress({ attempt: Number.NaN }))).toMatchObject({ retry: true });
    expect(decideSessionRetry(deadPreProgress({ maxAttempts: Number.NaN })).reason).toBe("off");
  });
});

describe("decideSpawnRetry (back-compat shim over decideSessionRetry)", () => {
  it("never retries when maxAttempts <= 1 (default OFF)", () => {
    expect(decideSpawnRetry(1, 1)).toEqual({ retry: false, backoffMs: 0 });
    expect(decideSpawnRetry(1, 0)).toEqual({ retry: false, backoffMs: 0 });
  });

  it("retries with exponential backoff while attempts remain, then stops at the ceiling", () => {
    expect(decideSpawnRetry(1, 3).retry).toBe(true);
    expect(decideSpawnRetry(2, 3).backoffMs).toBeGreaterThan(decideSpawnRetry(1, 3).backoffMs);
    expect(decideSpawnRetry(3, 3).retry).toBe(false);
  });

  it("caps the backoff", () => {
    expect(decideSpawnRetry(10, 99).backoffMs).toBeLessThanOrEqual(DEFAULT_SESSION_RETRY_BACKOFF.capMs);
  });
});
