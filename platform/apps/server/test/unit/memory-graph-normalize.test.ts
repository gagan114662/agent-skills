import { describe, it, expect } from "vitest";
import {
  clampConfidence,
  dedupeKey,
  normalizeText,
  subjectKey,
} from "../../src/memory-graph/normalize.js";

describe("memory-graph normalize", () => {
  it("normalizeText lowercases, trims, and collapses internal whitespace", () => {
    expect(normalizeText("  Acme   Corp\tInc \n")).toBe("acme corp inc");
  });

  it("subjectKey makes trivially-different subjects equal", () => {
    expect(subjectKey("Acme Corp")).toBe(subjectKey("acme   corp"));
    expect(subjectKey("Acme Corp")).not.toBe(subjectKey("Beta Corp"));
  });

  it("dedupeKey is stable across case/whitespace of the same statement", () => {
    const a = dedupeKey("research", "Growth Loops", null, "Referral loops win");
    const b = dedupeKey("research", "growth   loops", null, "referral loops WIN");
    expect(a).toBe(b);
  });

  it("dedupeKey separates different kinds, subjects, predicates, and values", () => {
    const base = dedupeKey("claim", "Acme", "pricing", "usage-based");
    expect(dedupeKey("note", "Acme", "pricing", "usage-based")).not.toBe(base);
    expect(dedupeKey("claim", "Beta", "pricing", "usage-based")).not.toBe(base);
    expect(dedupeKey("claim", "Acme", "headcount", "usage-based")).not.toBe(base);
    expect(dedupeKey("claim", "Acme", "pricing", "seat-based")).not.toBe(base);
  });

  it("dedupeKey distinguishes a null predicate from a present one (no collision)", () => {
    const finding = dedupeKey("claim", "Acme", null, "x");
    const claim = dedupeKey("claim", "Acme", "p", "x");
    expect(finding).not.toBe(claim);
  });

  it("clampConfidence bounds to [0,1] and defaults missing/invalid to 1", () => {
    expect(clampConfidence(undefined)).toBe(1);
    expect(clampConfidence(Number.NaN)).toBe(1);
    expect(clampConfidence(-2)).toBe(0);
    expect(clampConfidence(5)).toBe(1);
    expect(clampConfidence(0.42)).toBe(0.42);
  });
});
