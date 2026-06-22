/**
 * Unit tests for the factual-claim + source checker (issue #627, `brand-fact-gate/facts.ts`). Pure +
 * deterministic.
 */

import { describe, it, expect } from "vitest";
import { checkFactualClaims, splitSentences } from "../../src/brand-fact-gate/facts.js";

describe("checkFactualClaims — claim extraction", () => {
  it("finds hard statistics and flags them when unsourced", () => {
    const r = checkFactualClaims("Our platform makes teams 10x more productive.");
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]?.kind).toBe("statistic");
    expect(r.unsourced).toHaveLength(1);
    expect(r.worstUnsourcedSeverity).toBe("high");
  });

  it("finds appeals to research", () => {
    const r = checkFactualClaims("Studies show our users save two hours a day.");
    expect(r.claims[0]?.kind).toBe("research-appeal");
    expect(r.unsourced).toHaveLength(1);
  });

  it("finds ranking superlatives at medium severity", () => {
    const r = checkFactualClaims("We are the #1 CRM for startups.");
    expect(r.claims[0]?.kind).toBe("superlative");
    expect(r.claims[0]?.severity).toBe("medium");
  });

  it("returns no claims for an opinion with no checkable assertion", () => {
    const r = checkFactualClaims("We think great support makes happy customers.");
    expect(r.claims).toEqual([]);
    expect(r.worstUnsourcedSeverity).toBeNull();
  });

  it("treats empty / non-string input as no claims", () => {
    expect(checkFactualClaims("").claims).toEqual([]);
    // @ts-expect-error — total-function guard
    expect(checkFactualClaims(undefined).unsourced).toEqual([]);
  });
});

describe("checkFactualClaims — a claim is satisfied by a source on the page", () => {
  it("an inline URL counts as a source", () => {
    const r = checkFactualClaims("We grew revenue 40% last year (https://acme.com/2025-report).");
    expect(r.claims[0]?.sourced).toBe(true);
    expect(r.unsourced).toEqual([]);
  });

  it("a footnote marker counts as a source", () => {
    const r = checkFactualClaims("Churn dropped 30% after launch [1].");
    expect(r.claims[0]?.sourced).toBe(true);
  });

  it("an attribution phrase counts as a source", () => {
    const r = checkFactualClaims("According to Gartner, we are the #1 platform in the category.");
    expect(r.claims[0]?.sourced).toBe(true);
  });

  it("an unsourced sentence in the same draft is still flagged", () => {
    const r = checkFactualClaims(
      "Revenue grew 40% (https://acme.com/report). Separately, we are the fastest tool on the market.",
    );
    expect(r.claims).toHaveLength(2);
    expect(r.unsourced).toHaveLength(1);
    expect(r.unsourced[0]?.kind).toBe("superlative");
  });
});

describe("checkFactualClaims — brand-approved claims are pre-vouched", () => {
  it("a claim matching the brand allowlist needs no external citation", () => {
    const r = checkFactualClaims("We are the only SOC 2 Type II compliant CRM in our space.", {
      approvedClaims: ["the only SOC 2 Type II compliant CRM"],
    });
    expect(r.claims[0]?.sourced).toBe(true);
    expect(r.unsourced).toEqual([]);
  });

  it("a DIFFERENT claim is not covered by the allowlist", () => {
    const r = checkFactualClaims("We are the #1 fastest-growing CRM.", {
      approvedClaims: ["the only SOC 2 Type II compliant CRM"],
    });
    expect(r.unsourced).toHaveLength(1);
  });
});

describe("splitSentences", () => {
  it("splits on terminal punctuation and newlines, dropping blanks", () => {
    expect(splitSentences("One. Two!\nThree?  ")).toEqual(["One.", "Two!", "Three?"]);
  });
});
