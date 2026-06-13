import { describe, it, expect } from "vitest";
import { gradeDeliverable } from "../../src/verification/grade.js";
import type {
  CheckObservation,
  DefinitionOfDone,
  VerificationIdentity,
} from "../../src/verification/types.js";

const identity: VerificationIdentity = { workerMemberId: "worker-1", graderMemberId: "grader-2" };

const dod = (criteria: DefinitionOfDone["criteria"]): DefinitionOfDone => ({
  deliverableKind: "support_reply",
  reversibility: "reversible",
  criteria,
});

const obs = (over: Partial<CheckObservation> & { criterionId: string }): CheckObservation => ({
  satisfied: true,
  confidence: 0.95,
  evidence: "looks good",
  productionGrounded: false,
  ...over,
});

describe("verification/grade", () => {
  it("passes when every required check is satisfied", () => {
    const d = dod([{ id: "answers", text: "answers the question", category: "content", required: true }]);
    const verdict = gradeDeliverable(d, [obs({ criterionId: "answers" })], identity);
    expect(verdict.passed).toBe(true);
    expect(verdict.confidence).toBeCloseTo(0.95);
    expect(verdict.independenceOk).toBe(true);
  });

  it("fails when a required check is missing an observation (cannot verify ⇒ not passed)", () => {
    const d = dod([{ id: "answers", text: "answers", category: "content", required: true }]);
    const verdict = gradeDeliverable(d, [], identity);
    expect(verdict.passed).toBe(false);
    expect(verdict.confidence).toBe(0);
  });

  it("takes the MIN confidence over required checks (the weakest link)", () => {
    const d = dod([
      { id: "a", text: "a", category: "content", required: true },
      { id: "b", text: "b", category: "content", required: true },
    ]);
    const verdict = gradeDeliverable(
      d,
      [obs({ criterionId: "a", confidence: 0.99 }), obs({ criterionId: "b", confidence: 0.6 })],
      identity,
    );
    expect(verdict.confidence).toBeCloseTo(0.6);
  });

  it("FLAGS the worker grading its own homework (independence violated)", () => {
    const d = dod([{ id: "a", text: "a", category: "content", required: true }]);
    const verdict = gradeDeliverable(d, [obs({ criterionId: "a" })], {
      workerMemberId: "same",
      graderMemberId: "same",
    });
    expect(verdict.independenceOk).toBe(false);
  });

  it("a metric criterion only passes when backed by an EXTERNAL RECEIPT (premortem #2)", () => {
    const d = dod([{ id: "revenue", text: "real revenue moved", category: "metric", required: true }]);
    // estimate ⇒ UNVERIFIED ⇒ does not pass even though the grader said satisfied
    const estimate = gradeDeliverable(
      d,
      [obs({ criterionId: "revenue", metric: { name: "mrr", value: 100, provenance: "estimate" } })],
      identity,
    );
    expect(estimate.passed).toBe(false);
    expect(estimate.checks[0]?.metricVerified).toBe(false);

    // external receipt ⇒ VERIFIED ⇒ passes
    const receipt = gradeDeliverable(
      d,
      [
        obs({
          criterionId: "revenue",
          metric: { name: "mrr", value: 100, provenance: "external_receipt", receiptRef: "evt_123" },
        }),
      ],
      identity,
    );
    expect(receipt.passed).toBe(true);
    expect(receipt.checks[0]?.metricVerified).toBe(true);
  });

  it("a production criterion only passes on PRODUCTION-GROUNDED evidence (premortem #3)", () => {
    const d = dod([{ id: "live", text: "real click-through works", category: "production", required: true }]);
    const notGrounded = gradeDeliverable(
      d,
      [obs({ criterionId: "live", productionGrounded: false })],
      identity,
    );
    expect(notGrounded.passed).toBe(false);

    const grounded = gradeDeliverable(d, [obs({ criterionId: "live", productionGrounded: true })], identity);
    expect(grounded.passed).toBe(true);
    expect(grounded.productionGrounded).toBe(true);
  });

  it("ignores non-required criteria for the pass verdict but still grades them", () => {
    const d = dod([
      { id: "req", text: "required", category: "content", required: true },
      { id: "opt", text: "optional", category: "content", required: false },
    ]);
    const verdict = gradeDeliverable(
      d,
      [obs({ criterionId: "req" }), obs({ criterionId: "opt", satisfied: false })],
      identity,
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.checks).toHaveLength(2);
  });
});
