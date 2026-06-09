import { describe, it, expect } from "vitest";
import {
  decidePlan,
  validateDecisionInput,
  composeExecutionTask,
  parsePlanProposal,
  PlanError,
  PLAN_MARKER_START,
  PLAN_MARKER_END,
} from "../../src/turns/plan.js";

/**
 * Pure plan-mode logic (#53). No I/O — the plan state machine, execution-task composition, plan
 * parsing, and decision validation, so the controller/routes stay thin and these invariants are
 * locked by fast, hermetic tests.
 */
describe("decidePlan (#53 — plan state machine)", () => {
  it("maps approve / approve_with_feedback to proceed, reject to halt", () => {
    expect(decidePlan("proposed", "approve")).toEqual({ status: "approved", proceed: true });
    expect(decidePlan("proposed", "approve_with_feedback")).toEqual({
      status: "approved_with_feedback",
      proceed: true,
    });
    expect(decidePlan("proposed", "reject")).toEqual({ status: "rejected", proceed: false });
  });

  it("refuses to decide an already-decided plan", () => {
    for (const s of ["approved", "approved_with_feedback", "rejected"] as const) {
      expect(() => decidePlan(s, "approve")).toThrow(PlanError);
    }
  });
});

describe("validateDecisionInput (#53)", () => {
  it("requires non-empty feedback for approve_with_feedback", () => {
    expect(() => validateDecisionInput("approve_with_feedback")).toThrow(PlanError);
    expect(() => validateDecisionInput("approve_with_feedback", "   ")).toThrow(PlanError);
    expect(validateDecisionInput("approve_with_feedback", "  use TDD  ")).toEqual({
      decision: "approve_with_feedback",
      feedback: "use TDD",
    });
  });

  it("forbids feedback for approve and reject", () => {
    expect(() => validateDecisionInput("approve", "nope")).toThrow(PlanError);
    expect(() => validateDecisionInput("reject", "nope")).toThrow(PlanError);
    expect(validateDecisionInput("approve")).toEqual({ decision: "approve", feedback: null });
    expect(validateDecisionInput("reject")).toEqual({ decision: "reject", feedback: null });
  });

  it("rejects an unknown verb and over-long feedback", () => {
    expect(() => validateDecisionInput("yolo")).toThrow(PlanError);
    expect(() => validateDecisionInput("approve_with_feedback", "x".repeat(4001))).toThrow(PlanError);
  });
});

describe("composeExecutionTask (#53 — plan/feedback are data)", () => {
  it("includes the original task and the approved plan", () => {
    const t = composeExecutionTask("ship X", "1. read\n2. change", "approve");
    expect(t).toContain("ship X");
    expect(t).toContain("1. read");
    expect(t).toContain("2. change");
  });

  it("appends the reviewer feedback only for approve_with_feedback", () => {
    const withFb = composeExecutionTask("ship X", "the plan", "approve_with_feedback", "add tests first");
    expect(withFb).toContain("add tests first");
    const without = composeExecutionTask("ship X", "the plan", "approve");
    expect(without).not.toContain("add tests first");
  });

  it("throws for a rejected plan (no execution task exists)", () => {
    expect(() => composeExecutionTask("ship X", "the plan", "reject")).toThrow(PlanError);
  });
});

describe("parsePlanProposal (#53)", () => {
  it("extracts the delimited, trimmed plan block from harness output", () => {
    const out = [
      "agent: thinking…",
      PLAN_MARKER_START,
      "  1. read the code",
      "  2. make the change",
      PLAN_MARKER_END,
      "agent: proposed, awaiting approval",
    ].join("\n");
    expect(parsePlanProposal(out)).toBe("1. read the code\n  2. make the change");
  });

  it("returns null when there is no plan block or it is empty", () => {
    expect(parsePlanProposal("no markers here")).toBeNull();
    expect(parsePlanProposal(`${PLAN_MARKER_START}\n   \n${PLAN_MARKER_END}`)).toBeNull();
    expect(parsePlanProposal(`${PLAN_MARKER_START} unterminated`)).toBeNull();
  });
});
