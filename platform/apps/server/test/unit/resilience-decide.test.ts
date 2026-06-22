import { describe, it, expect } from "vitest";
import { decideRetry, type RetryCaps } from "../../src/resilience/decide.js";
import type { FailureClass } from "../../src/resilience/types.js";

const CAPS: RetryCaps = {
  maxAttempts: 4,
  baseMs: 200,
  factor: 2,
  maxDelayMs: 20_000,
  maxElapsedMs: 60_000,
  jitter: "none",
};

const transient: FailureClass = { transient: true, kind: "server", status: 503, retryAfterMs: null };
const permanent: FailureClass = { transient: false, kind: "permanent", status: 400, retryAfterMs: null };
const rateLimited: FailureClass = { transient: true, kind: "rate_limit", status: 429, retryAfterMs: 5_000 };

const base = { elapsedMs: 0, idempotent: true, caps: CAPS, rng: () => 0 };

describe("decideRetry — give-up precedence", () => {
  it("a permanent failure is never retried", () => {
    expect(decideRetry({ ...base, failure: permanent, attempt: 1 })).toEqual({
      action: "give_up",
      reason: "permanent",
      failure: permanent,
    });
  });

  it("a non-idempotent operation is never retried, even when transient", () => {
    const d = decideRetry({ ...base, failure: transient, attempt: 1, idempotent: false });
    expect(d).toMatchObject({ action: "give_up", reason: "not_idempotent" });
  });

  it("gives up once the attempt budget is spent", () => {
    const d = decideRetry({ ...base, failure: transient, attempt: 4 });
    expect(d).toMatchObject({ action: "give_up", reason: "exhausted_attempts" });
  });

  it("gives up when the next delay would exceed the time budget", () => {
    const d = decideRetry({ ...base, failure: transient, attempt: 1, elapsedMs: 59_900 });
    expect(d).toMatchObject({ action: "give_up", reason: "exhausted_time" });
  });

  it("permanent outranks every other reason", () => {
    const d = decideRetry({ ...base, failure: permanent, attempt: 99, idempotent: false, elapsedMs: 1e9 });
    expect(d).toMatchObject({ action: "give_up", reason: "permanent" });
  });
});

describe("decideRetry — retry", () => {
  it("retries a transient failure within budget, advancing the attempt", () => {
    const d = decideRetry({ ...base, failure: transient, attempt: 1 });
    expect(d).toEqual({ action: "retry", delayMs: 200, nextAttempt: 2, failure: transient });
  });

  it("respects Retry-After as the delay floor (#638)", () => {
    const d = decideRetry({ ...base, failure: rateLimited, attempt: 1 });
    expect(d).toMatchObject({ action: "retry", delayMs: 5_000, nextAttempt: 2 });
  });

  it("the attempt-budget boundary: attempt < max retries, attempt == max gives up", () => {
    expect(decideRetry({ ...base, failure: transient, attempt: 3 }).action).toBe("retry");
    expect(decideRetry({ ...base, failure: transient, attempt: 4 }).action).toBe("give_up");
  });
});
