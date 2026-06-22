import { describe, it, expect } from "vitest";
import {
  detectConflicts,
  isClaim,
  summarizeConflicts,
  type ClaimLike,
} from "../../src/memory-graph/conflict.js";

function claim(partial: Partial<ClaimLike> & Pick<ClaimLike, "id" | "value">): ClaimLike {
  return {
    subject: "Acme Corp",
    predicate: "pricing_model",
    confidence: 1,
    status: "active",
    ...partial,
  };
}

describe("memory-graph conflict detection", () => {
  it("flags two active claims about the same (subject, predicate) with different values", () => {
    const incoming = claim({ id: "c2", value: "seat-based" });
    const existing = [claim({ id: "c1", value: "usage-based" })];
    const conflicts = detectConflicts(incoming, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      subject: "Acme Corp",
      predicate: "pricing_model",
      existingNodeId: "c1",
      existingValue: "usage-based",
      incomingValue: "seat-based",
    });
  });

  it("treats the same value (modulo case/whitespace) as agreement, not a conflict", () => {
    const incoming = claim({ id: "c2", value: "Usage-Based" });
    const existing = [claim({ id: "c1", value: "usage-based" })];
    expect(detectConflicts(incoming, existing)).toHaveLength(0);
  });

  it("does not flag claims about a different subject or a different predicate", () => {
    const incoming = claim({ id: "c2", value: "seat-based" });
    const existing = [
      claim({ id: "c1", subject: "Beta Corp", value: "usage-based" }),
      claim({ id: "c3", predicate: "headcount", value: "usage-based" }),
    ];
    expect(detectConflicts(incoming, existing)).toHaveLength(0);
  });

  it("ignores superseded claims and findings (null predicate)", () => {
    const incoming = claim({ id: "c2", value: "seat-based" });
    const existing = [
      claim({ id: "c1", value: "usage-based", status: "superseded" }),
      claim({ id: "c3", predicate: null, value: "usage-based" }),
    ];
    expect(detectConflicts(incoming, existing)).toHaveLength(0);
  });

  it("returns [] when the incoming node is not a claim", () => {
    const finding = claim({ id: "f1", predicate: null, value: "anything" });
    const existing = [claim({ id: "c1", value: "usage-based" })];
    expect(detectConflicts(finding, existing)).toHaveLength(0);
  });

  it("never reports a claim as conflicting with itself", () => {
    const c = claim({ id: "c1", value: "usage-based" });
    expect(detectConflicts(c, [c])).toHaveLength(0);
  });

  it("isClaim requires active status and a non-empty predicate", () => {
    expect(isClaim({ status: "active", predicate: "p" })).toBe(true);
    expect(isClaim({ status: "active", predicate: null })).toBe(false);
    expect(isClaim({ status: "active", predicate: "" })).toBe(false);
    expect(isClaim({ status: "superseded", predicate: "p" })).toBe(false);
  });

  it("summarizeConflicts returns null when there is nothing to flag", () => {
    expect(summarizeConflicts([])).toBeNull();
  });

  it("summarizeConflicts produces a human-readable flag for pre-publish", () => {
    const incoming = claim({ id: "c2", value: "seat-based" });
    const existing = [claim({ id: "c1", value: "usage-based" })];
    const summary = summarizeConflicts(detectConflicts(incoming, existing));
    expect(summary).toContain("contradiction");
    expect(summary).toContain("usage-based");
    expect(summary).toContain("seat-based");
  });
});
