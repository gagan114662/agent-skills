import { describe, it, expect } from "vitest";
import { rateCapAllows, combineSendCaps } from "../../src/email/rate-cap.js";
import { warmupAllows } from "../../src/acquisition/compliance.js";

const MIN = 60_000;

describe("rateCapAllows (rolling-window send cap)", () => {
  it("counts only sends inside the trailing window", () => {
    const now = 10 * MIN;
    const d = rateCapAllows({
      sentAtMs: [now - 30 * MIN, now - 2 * MIN, now - MIN], // first is outside a 5-min window
      windowMs: 5 * MIN,
      capPerWindow: 5,
      requested: 1,
      now,
    });
    expect(d.inWindow).toBe(2);
    expect(d.grantable).toBe(1);
    expect(d.allowed).toBe(true);
  });

  it("grants only the remaining headroom under the cap", () => {
    const now = 10 * MIN;
    const d = rateCapAllows({
      sentAtMs: [now - MIN, now - MIN, now - MIN, now - MIN], // 4 used
      windowMs: 5 * MIN,
      capPerWindow: 5,
      requested: 3,
      now,
    });
    expect(d.grantable).toBe(1); // only 1 of 3 fits
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/cap/i);
  });

  it("blocks entirely when the window is already full", () => {
    const now = 10 * MIN;
    const d = rateCapAllows({
      sentAtMs: [now - MIN, now - MIN, now - MIN],
      windowMs: 5 * MIN,
      capPerWindow: 3,
      requested: 2,
      now,
    });
    expect(d.grantable).toBe(0);
    expect(d.allowed).toBe(false);
  });

  it("grants nothing for a non-positive cap", () => {
    const d = rateCapAllows({ sentAtMs: [], windowMs: MIN, capPerWindow: 0, requested: 5, now: 0 });
    expect(d.grantable).toBe(0);
    expect(d.allowed).toBe(false);
  });
});

describe("combineSendCaps (most-restrictive of warmup + rate caps)", () => {
  it("takes the minimum grantable across caps and reports the binding reason", () => {
    const now = 10 * MIN;
    const warmup = warmupAllows(0, 48, 10); // day-0 cap 50, 48 sent ⇒ grantable 2
    const rate = rateCapAllows({ sentAtMs: [], windowMs: MIN, capPerWindow: 100, requested: 10, now });
    const d = combineSendCaps(10, warmup, rate);
    expect(d.grantable).toBe(2); // warmup is the binding cap
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe(warmup.reason);
  });

  it("is blocked when any cap grants zero", () => {
    const warmup = warmupAllows(0, 50, 10); // day-0 cap 50, already at 50 ⇒ grantable 0
    const rate = rateCapAllows({ sentAtMs: [], windowMs: MIN, capPerWindow: 100, requested: 10, now: 0 });
    const d = combineSendCaps(10, warmup, rate);
    expect(d.grantable).toBe(0);
    expect(d.allowed).toBe(false);
  });

  it("never grants more than requested", () => {
    const warmup = warmupAllows(7, 0, 3); // warm domain ⇒ infinite headroom
    const rate = rateCapAllows({ sentAtMs: [], windowMs: MIN, capPerWindow: 1000, requested: 3, now: 0 });
    const d = combineSendCaps(3, warmup, rate);
    expect(d.grantable).toBe(3);
  });
});
