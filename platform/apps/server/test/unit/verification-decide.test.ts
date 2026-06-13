import { describe, it, expect } from "vitest";
import { decideVerification } from "../../src/verification/decide.js";
import { VERIFICATION_DEFAULTS, type VerificationCaps } from "../../src/verification/caps.js";
import type { DefinitionOfDone, VerificationVerdict } from "../../src/verification/types.js";

const caps = (over: Partial<VerificationCaps> = {}): VerificationCaps => ({
  ...VERIFICATION_DEFAULTS,
  enabled: true,
  ...over,
});

const dod = (over: Partial<DefinitionOfDone> = {}): DefinitionOfDone => ({
  deliverableKind: "support_reply",
  reversibility: "reversible",
  criteria: [{ id: "a", text: "a", category: "content", required: true }],
  ...over,
});

const verdict = (over: Partial<VerificationVerdict> = {}): VerificationVerdict => ({
  passed: true,
  confidence: 0.95,
  checks: [],
  workerMemberId: "w",
  graderMemberId: "g",
  independenceOk: true,
  productionGrounded: true,
  ...over,
});

describe("verification/decide", () => {
  it("ESCALATES when the grader is not independent of the worker (no self-grading)", () => {
    const d = decideVerification(verdict({ independenceOk: false }), dod(), caps(), 0);
    expect(d.action).toBe("escalate");
  });

  it("returns to the worker on a failed verification within the retry budget (fail→fix)", () => {
    const d = decideVerification(verdict({ passed: false }), dod(), caps({ maxRetries: 2 }), 0);
    expect(d.action).toBe("return_to_worker");
  });

  it("escalates to the decision queue after the retry budget is exhausted (repeated failure)", () => {
    const d = decideVerification(verdict({ passed: false }), dod(), caps({ maxRetries: 2 }), 2);
    expect(d.action).toBe("escalate");
  });

  it("an IRREVERSIBLE deliverable is ALWAYS human-gated, never auto (premortem #4)", () => {
    const d = decideVerification(
      verdict(),
      dod({ reversibility: "irreversible" }),
      caps({ autoSendReversible: true }), // even with auto-send on
      0,
    );
    expect(d.action).toBe("request_approval");
  });

  it("requests approval for a verified reversible deliverable when auto-send is OFF (default)", () => {
    const d = decideVerification(verdict(), dod({ reversibility: "reversible" }), caps(), 0);
    expect(d.action).toBe("request_approval");
  });

  it("auto-proceeds only for a verified REVERSIBLE deliverable when auto-send is opted in", () => {
    const d = decideVerification(
      verdict(),
      dod({ reversibility: "reversible" }),
      caps({ autoSendReversible: true }),
      0,
    );
    expect(d.action).toBe("auto_proceed");
  });

  it("never auto-proceeds a CHEAP deliverable even with auto-send on (only reversible may)", () => {
    const d = decideVerification(
      verdict(),
      dod({ reversibility: "cheap" }),
      caps({ autoSendReversible: true }),
      0,
    );
    expect(d.action).toBe("request_approval");
  });

  it("requests approval (never auto) when a pass is below the confidence threshold", () => {
    const d = decideVerification(
      verdict({ confidence: 0.5 }),
      dod({ reversibility: "reversible" }),
      caps({ autoSendReversible: true, minConfidence: 0.8 }),
      0,
    );
    expect(d.action).toBe("request_approval");
  });

  it("a venture deploy missing production grounding returns to the worker (premortem #3)", () => {
    const d = decideVerification(
      verdict({ productionGrounded: false }),
      dod({ deliverableKind: "venture_deploy", reversibility: "irreversible" }),
      caps({ requireProductionGrounding: true, maxRetries: 2 }),
      0,
    );
    expect(d.action).toBe("return_to_worker");
  });

  it("escalates a venture deploy that never reaches production grounding within budget", () => {
    const d = decideVerification(
      verdict({ productionGrounded: false }),
      dod({ deliverableKind: "venture_deploy", reversibility: "irreversible" }),
      caps({ requireProductionGrounding: true, maxRetries: 2 }),
      2,
    );
    expect(d.action).toBe("escalate");
  });
});
