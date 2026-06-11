import { describe, it, expect } from "vitest";
import { evaluateLoveGate } from "../../src/constitution/love-gate.js";

const base = {
  enabled: true,
  segment: "b2b" as const,
  unaffiliatedPayingIntentSignals: 3,
  minSignals: 10,
  stage: "FUND" as const,
};

describe("evaluateLoveGate (Article I — the love paradigm)", () => {
  it("gates a B2B FUND that lacks enough unaffiliated paying-intent signals", () => {
    const r = evaluateLoveGate({ ...base, verdict: "FUND" });
    expect(r.gated).toBe(true);
    expect(r.violation).not.toBeNull();
    expect(r.violation?.article).toBe("I");
    expect(r.violation?.code).toBe("love_paradigm_unmet");
    expect(r.violation?.severity).toBe("block");
    expect(r.violation?.stage).toBe("FUND");
  });

  it("passes a B2B FUND once it meets the threshold", () => {
    const r = evaluateLoveGate({ ...base, verdict: "FUND", unaffiliatedPayingIntentSignals: 10 });
    expect(r.gated).toBe(false);
    expect(r.violation).toBeNull();
  });

  it("never gates a B2C venture (the gate is B2B-only)", () => {
    const r = evaluateLoveGate({ ...base, verdict: "FUND", segment: "b2c" });
    expect(r.gated).toBe(false);
    expect(r.violation).toBeNull();
  });

  it("never gates a venture with no declared segment", () => {
    const r = evaluateLoveGate({ ...base, verdict: "FUND", segment: null });
    expect(r.gated).toBe(false);
  });

  it("only applies to a FUND verdict — KILL/ITERATE/ESCALATE pass through", () => {
    expect(evaluateLoveGate({ ...base, verdict: "KILL" }).gated).toBe(false);
    expect(evaluateLoveGate({ ...base, verdict: "ITERATE" }).gated).toBe(false);
    expect(evaluateLoveGate({ ...base, verdict: "ESCALATE" }).gated).toBe(false);
  });

  it("is inert when the constitution is disabled", () => {
    const r = evaluateLoveGate({ ...base, verdict: "FUND", enabled: false });
    expect(r.gated).toBe(false);
    expect(r.violation).toBeNull();
  });
});
