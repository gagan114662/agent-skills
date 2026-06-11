import { describe, it, expect } from "vitest";
import { evaluateClaim, summarizeOutcomeEvidence } from "../../src/verifiers/registry.js";
import type { Observation, VerifierClaim, VerifierResultRecord } from "../../src/verifiers/types.js";

const claim = (over: Partial<VerifierClaim> & Pick<VerifierClaim, "kind">): VerifierClaim => ({
  workspaceId: "ws",
  claimRef: "ref",
  target: 1,
  ...over,
});

describe("verifiers/registry — pure verifiers", () => {
  describe("deploy_live", () => {
    it("passes when healthy + 2xx", () => {
      const o = evaluateClaim(claim({ kind: "deploy_live" }), {
        kind: "deploy_live",
        httpStatus: 200,
        healthy: true,
      });
      expect(o.passed).toBe(true);
      expect(o.measuredValue).toBe(200);
    });

    it("fails on a 5xx even if healthy flag is true", () => {
      const o = evaluateClaim(claim({ kind: "deploy_live" }), {
        kind: "deploy_live",
        httpStatus: 503,
        healthy: true,
      });
      expect(o.passed).toBe(false);
    });

    it("fails when unhealthy even on a 200", () => {
      const o = evaluateClaim(claim({ kind: "deploy_live" }), {
        kind: "deploy_live",
        httpStatus: 200,
        healthy: false,
      });
      expect(o.passed).toBe(false);
    });
  });

  describe("revenue_real", () => {
    it("passes at the target boundary (≥ 1 settled event)", () => {
      const o = evaluateClaim(claim({ kind: "revenue_real", target: 1 }), {
        kind: "revenue_real",
        realEventCount: 1,
      });
      expect(o.passed).toBe(true);
      expect(o.threshold).toBe(1);
    });

    it("fails with zero settled events (a fake-door click is not revenue)", () => {
      const o = evaluateClaim(claim({ kind: "revenue_real", target: 1 }), {
        kind: "revenue_real",
        realEventCount: 0,
      });
      expect(o.passed).toBe(false);
    });

    it("treats a target below 1 as 1 (at least one real event is always required)", () => {
      const o = evaluateClaim(claim({ kind: "revenue_real", target: 0 }), {
        kind: "revenue_real",
        realEventCount: 0,
      });
      expect(o.passed).toBe(false);
      expect(o.threshold).toBe(1);
    });
  });

  describe("growth_metric", () => {
    it("passes when the delta meets the target move", () => {
      const o = evaluateClaim(claim({ kind: "growth_metric", target: 10 }), {
        kind: "growth_metric",
        currentValue: 120,
        baselineValue: 100,
      });
      expect(o.passed).toBe(true);
      expect(o.measuredValue).toBe(20);
    });

    it("fails when the metric did not move past the threshold", () => {
      const o = evaluateClaim(claim({ kind: "growth_metric", target: 10 }), {
        kind: "growth_metric",
        currentValue: 105,
        baselineValue: 100,
      });
      expect(o.passed).toBe(false);
      expect(o.measuredValue).toBe(5);
    });

    it("fails on a regression (negative delta)", () => {
      const o = evaluateClaim(claim({ kind: "growth_metric", target: 0 }), {
        kind: "growth_metric",
        currentValue: 90,
        baselineValue: 100,
      });
      expect(o.passed).toBe(false);
    });
  });

  describe("fix_held", () => {
    it("passes with zero recurrences", () => {
      const o = evaluateClaim(claim({ kind: "fix_held" }), { kind: "fix_held", recurrenceCount: 0 });
      expect(o.passed).toBe(true);
    });

    it("fails when the fix did not hold (a recurrence)", () => {
      const o = evaluateClaim(claim({ kind: "fix_held" }), { kind: "fix_held", recurrenceCount: 1 });
      expect(o.passed).toBe(false);
      expect(o.measuredValue).toBe(1);
    });
  });

  it("is deterministic — same input, same outcome", () => {
    const c = claim({ kind: "growth_metric", target: 5 });
    const obs: Observation = { kind: "growth_metric", currentValue: 110, baselineValue: 100 };
    expect(evaluateClaim(c, obs)).toEqual(evaluateClaim(c, obs));
  });

  it("throws when the observation kind mismatches the claim kind", () => {
    expect(() =>
      evaluateClaim(claim({ kind: "deploy_live" }), { kind: "fix_held", recurrenceCount: 0 }),
    ).toThrow(/does not match/);
  });
});

describe("verifiers/registry — summarizeOutcomeEvidence (consumed by #96/#117/#119)", () => {
  const row = (over: Partial<VerifierResultRecord>): VerifierResultRecord => ({
    id: "id",
    workspaceId: "ws",
    kind: "deploy_live",
    claimRef: "ref",
    status: "passed",
    measuredValue: 0,
    threshold: 0,
    detail: "",
    escalationRequestId: null,
    source: null,
    createdAt: new Date(),
    ...over,
  });

  it("computes pass-rate over measured (non-errored) rows", () => {
    const s = summarizeOutcomeEvidence([
      row({ status: "passed" }),
      row({ status: "failed" }),
      row({ status: "passed" }),
      row({ status: "errored" }),
    ]);
    expect(s.total).toBe(4);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.errored).toBe(1);
    expect(s.passRate).toBeCloseTo(2 / 3);
  });

  it("takes the latest status per claim (first row wins on newest-first input)", () => {
    const s = summarizeOutcomeEvidence([
      row({ kind: "fix_held", claimRef: "fp1", status: "failed" }), // newest
      row({ kind: "fix_held", claimRef: "fp1", status: "passed" }), // older
    ]);
    expect(s.latestByClaim["fix_held|fp1"]).toBe("failed");
  });

  it("returns a 0 pass-rate when nothing was measured", () => {
    expect(summarizeOutcomeEvidence([row({ status: "errored" })]).passRate).toBe(0);
  });
});
