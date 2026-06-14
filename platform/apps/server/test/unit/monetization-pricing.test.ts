import { describe, it, expect } from "vitest";
import {
  validatePricingDraft,
  projectExperimentImpact,
  summarizeExperimentResult,
  summarizeActivation,
  summarizePayoutSettings,
  formatMoney,
  formatPrice,
  isPriceInterval,
  MONEY_DECISION_KINDS,
} from "../../src/monetization/pricing.js";

/**
 * Pure-core tests for venture monetization (#188). No DB, no Stripe — just the validation + the honest,
 * clearly-labeled money math the #13 / Slack card renders from.
 */

describe("validatePricingDraft", () => {
  it("accepts a well-formed recurring draft", () => {
    expect(validatePricingDraft({ name: "Pro", amountCents: 2500, currency: "usd", interval: "month" })).toEqual({
      ok: true,
    });
  });

  it("accepts a one-time draft (null interval)", () => {
    expect(validatePricingDraft({ name: "Lifetime", amountCents: 9900, currency: "usd", interval: null }).ok).toBe(
      true,
    );
  });

  it("rejects a non-object", () => {
    expect(validatePricingDraft(null)).toMatchObject({ ok: false });
    expect(validatePricingDraft([])).toMatchObject({ ok: false });
  });

  it("rejects an empty name", () => {
    expect(validatePricingDraft({ name: "  ", amountCents: 100, currency: "usd", interval: null })).toMatchObject({
      ok: false,
      error: "name required",
    });
  });

  it("rejects a non-positive or non-integer amount", () => {
    expect(validatePricingDraft({ name: "x", amountCents: 0, currency: "usd", interval: null }).ok).toBe(false);
    expect(validatePricingDraft({ name: "x", amountCents: -5, currency: "usd", interval: null }).ok).toBe(false);
    expect(validatePricingDraft({ name: "x", amountCents: 9.9, currency: "usd", interval: null }).ok).toBe(false);
  });

  it("rejects a non-3-letter currency", () => {
    expect(validatePricingDraft({ name: "x", amountCents: 100, currency: "dollars", interval: null }).ok).toBe(false);
  });

  it("rejects an invalid interval", () => {
    expect(validatePricingDraft({ name: "x", amountCents: 100, currency: "usd", interval: "fortnight" }).ok).toBe(
      false,
    );
  });
});

describe("isPriceInterval", () => {
  it("accepts the four intervals and null", () => {
    for (const v of ["day", "week", "month", "year", null]) expect(isPriceInterval(v)).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isPriceInterval("hour")).toBe(false);
    expect(isPriceInterval(undefined)).toBe(false);
  });
});

describe("projectExperimentImpact", () => {
  it("computes the per-arm revenue, signed delta, and pct — labeled UNVERIFIED", () => {
    // baseline: $20 × 100 = $2000; candidate: $25 × 90 = $2250 → +$250 (+12.5%)
    const p = projectExperimentImpact({
      baselineAmountCents: 2000,
      candidateAmountCents: 2500,
      baselineConversions: 100,
      candidateConversions: 90,
    });
    expect(p.baselineRevenueCents).toBe(200_000);
    expect(p.candidateRevenueCents).toBe(225_000);
    expect(p.deltaCents).toBe(25_000);
    expect(p.deltaPct).toBe(12.5);
    expect(p.estimateLabel).toBe("UNVERIFIED");
  });

  it("never claims a result — the label is always UNVERIFIED even for a projected drop", () => {
    const p = projectExperimentImpact({
      baselineAmountCents: 2000,
      candidateAmountCents: 1000,
      baselineConversions: 100,
      candidateConversions: 100,
    });
    expect(p.deltaCents).toBeLessThan(0);
    expect(p.estimateLabel).toBe("UNVERIFIED");
  });

  it("guards a zero baseline (no divide-by-zero)", () => {
    const p = projectExperimentImpact({
      baselineAmountCents: 0,
      candidateAmountCents: 1000,
      baselineConversions: 0,
      candidateConversions: 10,
    });
    expect(p.deltaPct).toBe(0);
    expect(p.candidateRevenueCents).toBe(10_000);
  });

  it("clamps negative inputs to zero", () => {
    const p = projectExperimentImpact({
      baselineAmountCents: -100,
      candidateAmountCents: -100,
      baselineConversions: -5,
      candidateConversions: -5,
    });
    expect(p.baselineRevenueCents).toBe(0);
    expect(p.candidateRevenueCents).toBe(0);
  });
});

describe("summarizeExperimentResult", () => {
  it("computes the realized (verified) delta vs. the proposed baseline", () => {
    const r = summarizeExperimentResult({
      verifiedRevenueCents: 230_000,
      baselineRevenueCents: 200_000,
      projectedDeltaCents: 25_000,
    });
    expect(r.verifiedRevenueCents).toBe(230_000);
    expect(r.realizedDeltaCents).toBe(30_000);
    expect(r.projectedDeltaCents).toBe(25_000);
  });

  it("clamps negative verified revenue to zero", () => {
    const r = summarizeExperimentResult({ verifiedRevenueCents: -10, baselineRevenueCents: 0, projectedDeltaCents: 0 });
    expect(r.verifiedRevenueCents).toBe(0);
  });
});

describe("formatMoney / formatPrice", () => {
  it("formats usd with a $ symbol", () => {
    expect(formatMoney(2500, "usd")).toBe("$25.00");
  });
  it("formats other currencies with the code", () => {
    expect(formatMoney(2500, "eur")).toBe("25.00 EUR");
  });
  it("appends the interval", () => {
    expect(formatPrice(2500, "usd", "month")).toBe("$25.00/month");
    expect(formatPrice(2500, "usd", null)).toBe("$25.00");
  });
});

describe("summarizeActivation", () => {
  it("renders the exact amount for a first activation", () => {
    expect(
      summarizeActivation({
        ventureName: "Acme",
        planName: "Pro",
        amountCents: 2500,
        currency: "usd",
        interval: "month",
      }),
    ).toBe('Activate "Pro" pricing for Acme: $25.00/month (customers can pay)');
  });

  it("renders before→after for a re-price", () => {
    expect(
      summarizeActivation({
        ventureName: "Acme",
        planName: "Pro",
        amountCents: 3000,
        currency: "usd",
        interval: "month",
        previousAmountCents: 2500,
      }),
    ).toBe('Re-price "Pro" for Acme: $25.00/month → $30.00/month');
  });
});

describe("summarizePayoutSettings", () => {
  it("names the venture and destination", () => {
    expect(summarizePayoutSettings({ ventureName: "Acme", destination: "acct_123" })).toBe(
      "Change payout settings for Acme: route to acct_123",
    );
  });
});

describe("MONEY_DECISION_KINDS", () => {
  it("covers activation, price change, and payout settings", () => {
    expect([...MONEY_DECISION_KINDS]).toEqual(["activate_price", "price_change", "payout_settings"]);
  });
});
