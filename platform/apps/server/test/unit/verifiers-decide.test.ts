import { describe, it, expect } from "vitest";
import { decideVerification } from "../../src/verifiers/decide.js";
import { VERIFIER_DEFAULTS, type VerifierCaps } from "../../src/verifiers/caps.js";
import type { VerifierOutcome } from "../../src/verifiers/types.js";

const caps = (over: Partial<VerifierCaps> = {}): VerifierCaps => ({ ...VERIFIER_DEFAULTS, ...over });
const outcome = (passed: boolean): VerifierOutcome => ({
  passed,
  measuredValue: passed ? 1 : 0,
  threshold: 1,
  detail: passed ? "ok" : "bad",
});

describe("verifiers/decide", () => {
  it("records a pass", () => {
    const d = decideVerification(outcome(true), caps());
    expect(d).toMatchObject({ action: "record_pass", status: "passed" });
  });

  it("escalates a measured failure when escalation is on (the no-silent-pass rail)", () => {
    const d = decideVerification(outcome(false), caps({ escalateOnFailure: true }));
    expect(d).toMatchObject({ action: "escalate", status: "failed" });
  });

  it("still records a failure (never a pass) when escalation is off", () => {
    const d = decideVerification(outcome(false), caps({ escalateOnFailure: false }));
    expect(d).toMatchObject({ action: "skip", status: "failed" });
  });

  it("skips an un-measurable probe as errored (does not escalate — never cries wolf)", () => {
    const d = decideVerification({ errored: true }, caps());
    expect(d).toMatchObject({ action: "skip", status: "errored" });
  });
});
