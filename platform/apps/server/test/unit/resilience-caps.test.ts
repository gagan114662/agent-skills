import { describe, it, expect } from "vitest";
import { resolveResilienceCaps, RESILIENCE_DEFAULTS } from "../../src/resilience/caps.js";

describe("resolveResilienceCaps", () => {
  it("defaults to retries OFF with sensible numbers (parallel-merge safe)", () => {
    const caps = resolveResilienceCaps({});
    expect(caps.retry.enabled).toBe(false);
    expect(caps).toEqual(RESILIENCE_DEFAULTS);
  });

  it("turns retries on via the flag", () => {
    expect(resolveResilienceCaps({ RESILIENCE_RETRY_ENABLED: "1" }).retry.enabled).toBe(true);
    expect(resolveResilienceCaps({ RESILIENCE_RETRY_ENABLED: "true" }).retry.enabled).toBe(true);
    expect(resolveResilienceCaps({ RESILIENCE_RETRY_ENABLED: "no" }).retry.enabled).toBe(false);
  });

  it("reads numeric knobs from the environment", () => {
    const caps = resolveResilienceCaps({
      RESILIENCE_RETRY_MAX_ATTEMPTS: "6",
      RESILIENCE_RETRY_BASE_MS: "500",
      RESILIENCE_RETRY_FACTOR: "3",
      RESILIENCE_RETRY_MAX_DELAY_MS: "30000",
      RESILIENCE_RETRY_MAX_ELAPSED_MS: "120000",
      RESILIENCE_RATE_MIN_INTERVAL_MS: "250",
    });
    expect(caps.retry).toMatchObject({ maxAttempts: 6, baseMs: 500, factor: 3, maxDelayMs: 30_000, maxElapsedMs: 120_000 });
    expect(caps.pacing.minIntervalMs).toBe(250);
  });

  it("ignores invalid / non-positive values, keeping defaults", () => {
    const caps = resolveResilienceCaps({
      RESILIENCE_RETRY_MAX_ATTEMPTS: "0",
      RESILIENCE_RETRY_BASE_MS: "-5",
      RESILIENCE_RETRY_FACTOR: "abc",
    });
    expect(caps.retry.maxAttempts).toBe(RESILIENCE_DEFAULTS.retry.maxAttempts);
    expect(caps.retry.baseMs).toBe(RESILIENCE_DEFAULTS.retry.baseMs);
    expect(caps.retry.factor).toBe(RESILIENCE_DEFAULTS.retry.factor);
  });

  it("allows minIntervalMs of 0 (pacing off) but rejects negatives", () => {
    expect(resolveResilienceCaps({ RESILIENCE_RATE_MIN_INTERVAL_MS: "0" }).pacing.minIntervalMs).toBe(0);
    expect(resolveResilienceCaps({ RESILIENCE_RATE_MIN_INTERVAL_MS: "-1" }).pacing.minIntervalMs).toBe(0);
  });

  it("parses the jitter mode", () => {
    expect(resolveResilienceCaps({ RESILIENCE_RETRY_JITTER: "none" }).retry.jitter).toBe("none");
    expect(resolveResilienceCaps({ RESILIENCE_RETRY_JITTER: "FULL" }).retry.jitter).toBe("full");
    expect(resolveResilienceCaps({ RESILIENCE_RETRY_JITTER: "weird" }).retry.jitter).toBe("full");
  });
});
