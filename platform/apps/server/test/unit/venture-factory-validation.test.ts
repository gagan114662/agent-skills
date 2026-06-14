import { describe, it, expect } from "vitest";
import {
  decideValidationSpend,
  scoreFromReceipts,
  decideValidationOutcome,
  type ValidationOutcomeThresholds,
} from "../../src/venture-factory/validation.js";
import type { ValidationReceipt } from "../../src/venture-factory/types.js";

const OCC = new Date("2026-06-13T00:00:00Z");

describe("decideValidationSpend (hard budget cap)", () => {
  it("allows a charge that stays under the cap and reports remaining", () => {
    const d = decideValidationSpend({ budgetCapCents: 5000, spentCents: 1000, requestedCents: 1000 });
    expect(d.allowed).toBe(true);
    expect(d.remainingCents).toBe(3000);
  });

  it("allows a charge exactly to the cap (boundary)", () => {
    expect(decideValidationSpend({ budgetCapCents: 5000, spentCents: 4000, requestedCents: 1000 }).allowed).toBe(true);
  });

  it("BLOCKS a charge that would exceed the cap", () => {
    const d = decideValidationSpend({ budgetCapCents: 5000, spentCents: 4500, requestedCents: 1000 });
    expect(d.allowed).toBe(false);
    expect(d.remainingCents).toBe(500);
    expect(d.reason).toMatch(/budget cap/);
  });

  it("blocks a non-positive charge", () => {
    expect(decideValidationSpend({ budgetCapCents: 5000, spentCents: 0, requestedCents: 0 }).allowed).toBe(false);
  });

  it("never reports negative remaining when already over", () => {
    expect(decideValidationSpend({ budgetCapCents: 100, spentCents: 200, requestedCents: 50 }).remainingCents).toBe(0);
  });
});

describe("scoreFromReceipts (EXTERNAL receipts only, derived = UNVERIFIED)", () => {
  function receipt(over: Partial<ValidationReceipt>): ValidationReceipt {
    return { kind: "signup", amountCents: 0, externalRef: "wh_1", occurredAt: OCC, ...over };
  }

  it("counts external signups and ad spend, computes CAC, labels UNVERIFIED", () => {
    const card = scoreFromReceipts(
      [
        receipt({ kind: "signup" }),
        receipt({ kind: "signup" }),
        receipt({ kind: "ad_spend", amountCents: 1000 }),
      ],
      { pointsPerSignup: 10 },
    );
    expect(card.signups).toBe(2);
    expect(card.spentCents).toBe(1000);
    expect(card.cacCents).toBe(500);
    expect(card.score).toBe(20);
    expect(card.estimateLabel).toBe("UNVERIFIED");
  });

  it("CAC is null with zero signups (never divides by zero)", () => {
    const card = scoreFromReceipts([receipt({ kind: "ad_spend", amountCents: 5000 })], { pointsPerSignup: 10 });
    expect(card.signups).toBe(0);
    expect(card.cacCents).toBeNull();
    expect(card.score).toBe(0);
  });

  it("caps the derived score at 100", () => {
    const many = Array.from({ length: 20 }, () => receipt({ kind: "signup" }));
    expect(scoreFromReceipts(many, { pointsPerSignup: 10 }).score).toBe(100);
  });
});

describe("decideValidationOutcome", () => {
  const thresholds: ValidationOutcomeThresholds = { minSignups: 50, maxCacCents: 500, killSignups: 5 };

  it("KILLs at/below the clear-failure floor", () => {
    const card = scoreFromReceipts(
      Array.from({ length: 5 }, () => ({ kind: "signup" as const, amountCents: 0, externalRef: "x", occurredAt: OCC })),
      { pointsPerSignup: 1 },
    );
    expect(decideValidationOutcome({ scorecard: card, budgetExhausted: false, thresholds }).verdict).toBe("KILL");
  });

  it("PROMOTEs on a real signup floor under the CAC ceiling", () => {
    const receipts: ValidationReceipt[] = [
      ...Array.from({ length: 60 }, () => ({ kind: "signup" as const, amountCents: 0, externalRef: "x", occurredAt: OCC })),
      { kind: "ad_spend", amountCents: 12_000, externalRef: "ad", occurredAt: OCC }, // CAC 200¢
    ];
    const card = scoreFromReceipts(receipts, { pointsPerSignup: 1 });
    expect(decideValidationOutcome({ scorecard: card, budgetExhausted: false, thresholds }).verdict).toBe("PROMOTE");
  });

  it("PROMOTEs organic signups (no ad spend → CAC 0) above the floor", () => {
    const card = scoreFromReceipts(
      Array.from({ length: 60 }, () => ({ kind: "signup" as const, amountCents: 0, externalRef: "x", occurredAt: OCC })),
      { pointsPerSignup: 1 },
    );
    expect(card.cacCents).toBe(0); // organic = zero CAC, not null (null is only at zero signups)
    expect(decideValidationOutcome({ scorecard: card, budgetExhausted: false, thresholds }).verdict).toBe("PROMOTE");
  });

  it("does NOT promote when CAC exceeds the ceiling — INCONCLUSIVE, keep validating", () => {
    const receipts: ValidationReceipt[] = [
      ...Array.from({ length: 60 }, () => ({ kind: "signup" as const, amountCents: 0, externalRef: "x", occurredAt: OCC })),
      { kind: "ad_spend", amountCents: 60_000, externalRef: "ad", occurredAt: OCC }, // CAC 1000¢ > 500
    ];
    const card = scoreFromReceipts(receipts, { pointsPerSignup: 1 });
    expect(decideValidationOutcome({ scorecard: card, budgetExhausted: false, thresholds }).verdict).toBe("INCONCLUSIVE");
  });

  it("escalates (INCONCLUSIVE) when the budget is exhausted mid-band", () => {
    const card = scoreFromReceipts(
      Array.from({ length: 20 }, () => ({ kind: "signup" as const, amountCents: 0, externalRef: "x", occurredAt: OCC })),
      { pointsPerSignup: 1 },
    );
    const d = decideValidationOutcome({ scorecard: card, budgetExhausted: true, thresholds });
    expect(d.verdict).toBe("INCONCLUSIVE");
    expect(d.reasoning).toMatch(/budget exhausted/);
  });
});
