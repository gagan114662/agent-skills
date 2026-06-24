import { describe, it, expect } from "vitest";
import {
  classifyReversibility,
  deriveDefinitionOfDone,
  validateDefinitionOfDone,
} from "../../src/verification/criteria.js";

describe("verification/criteria", () => {
  describe("classifyReversibility", () => {
    it("treats outbound content as irreversible (deliverability + brand cannot be unsent)", () => {
      expect(classifyReversibility("outbound_content")).toBe("irreversible");
    });
    it("treats a venture deploy as irreversible (money/legal/brand blast radius)", () => {
      expect(classifyReversibility("venture_deploy")).toBe("irreversible");
    });
    it("treats a support reply as reversible (1:1, can be followed up / corrected)", () => {
      expect(classifyReversibility("support_reply")).toBe("reversible");
    });
    it("treats a campaign change as cheap (reversible with some cost — can be paused)", () => {
      expect(classifyReversibility("campaign_change")).toBe("cheap");
    });
    it("honors a conservative hint but never downgrades below the kind's floor", () => {
      // A hint may TIGHTEN (reversible kind → irreversible) but never LOOSEN an irreversible kind.
      expect(classifyReversibility("support_reply", "irreversible")).toBe("irreversible");
      expect(classifyReversibility("venture_deploy", "reversible")).toBe("irreversible");
    });
  });

  describe("deriveDefinitionOfDone", () => {
    it("derives a definition of done from the brief before doing (AC #1)", () => {
      const dod = deriveDefinitionOfDone({
        deliverableKind: "support_reply",
        brief: "Answer the customer's refund question accurately and kindly.",
      });
      expect(dod.deliverableKind).toBe("support_reply");
      expect(dod.reversibility).toBe("reversible");
      expect(dod.criteria.length).toBeGreaterThan(0);
      // at least one required criterion or the gate is theatre
      expect(dod.criteria.some((c) => c.required)).toBe(true);
      // criterion ids are unique slugs
      const ids = dod.criteria.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("adds a production-grounded criterion for a venture deploy (premortem #3 final tier)", () => {
      const dod = deriveDefinitionOfDone({
        deliverableKind: "venture_deploy",
        brief: "Ship the landing page to production.",
      });
      expect(dod.criteria.some((c) => c.category === "production" && c.required)).toBe(true);
    });

    it("is deterministic — same input yields the same definition of done", () => {
      const input = { deliverableKind: "outbound_content" as const, brief: "Announce the launch." };
      expect(deriveDefinitionOfDone(input)).toEqual(deriveDefinitionOfDone(input));
    });

    it("requires originality for outbound content (#854)", () => {
      const dod = deriveDefinitionOfDone({ deliverableKind: "outbound_content", brief: "Draft launch copy." });
      expect(dod.criteria).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "originality", category: "content", required: true }),
        ]),
      );
    });
  });

  describe("validateDefinitionOfDone", () => {
    it("accepts a well-formed definition of done", () => {
      const dod = deriveDefinitionOfDone({ deliverableKind: "support_reply", brief: "x" });
      expect(validateDefinitionOfDone(dod)).toEqual([]);
    });
    it("rejects a definition with no required criteria (the gate would be theatre)", () => {
      const problems = validateDefinitionOfDone({
        deliverableKind: "support_reply",
        reversibility: "reversible",
        criteria: [{ id: "a", text: "nice to have", category: "content", required: false }],
      });
      expect(problems.length).toBeGreaterThan(0);
    });
    it("rejects duplicate criterion ids", () => {
      const problems = validateDefinitionOfDone({
        deliverableKind: "support_reply",
        reversibility: "reversible",
        criteria: [
          { id: "dup", text: "a", category: "content", required: true },
          { id: "dup", text: "b", category: "content", required: true },
        ],
      });
      expect(problems.length).toBeGreaterThan(0);
    });
  });
});
