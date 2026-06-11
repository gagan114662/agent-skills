import { describe, it, expect } from "vitest";
import { breaches, budgetExhausted, severityFor, cooldownElapsed } from "../../src/sre/guards.js";

describe("breaches — kind-aware threshold comparison", () => {
  it("availability breaches strictly below target", () => {
    expect(breaches("availability", 0.98, 0.99)).toBe(true);
    expect(breaches("availability", 0.99, 0.99)).toBe(false);
    expect(breaches("availability", 1, 0.99)).toBe(false);
  });

  it("latency + queue lag breach strictly above target", () => {
    expect(breaches("latency_p95", 600, 500)).toBe(true);
    expect(breaches("latency_p95", 500, 500)).toBe(false);
    expect(breaches("queue_lag", 3, 2)).toBe(true);
    expect(breaches("queue_lag", 2, 2)).toBe(false);
  });
});

describe("budgetExhausted", () => {
  it("is true only when no budget remains", () => {
    expect(budgetExhausted(0)).toBe(true);
    expect(budgetExhausted(0.0001)).toBe(false);
    expect(budgetExhausted(1)).toBe(false);
  });
});

describe("severityFor", () => {
  it("is critical only once the burn reaches the critical threshold (default full burn)", () => {
    expect(severityFor(1)).toBe("warning");
    expect(severityFor(0.5)).toBe("warning");
    expect(severityFor(0)).toBe("critical");
  });

  it("honors a custom critical-at-burn threshold", () => {
    expect(severityFor(0.5, 0.5)).toBe("critical"); // burn 0.5 >= 0.5
    expect(severityFor(0.6, 0.5)).toBe("warning"); // burn 0.4 < 0.5
  });
});

describe("cooldownElapsed", () => {
  it("is true once enough time has passed since the last notify (Infinity = never notified)", () => {
    expect(cooldownElapsed(Number.POSITIVE_INFINITY, 60_000)).toBe(true);
    expect(cooldownElapsed(90_000, 60_000)).toBe(true);
    expect(cooldownElapsed(30_000, 60_000)).toBe(false);
  });
});
