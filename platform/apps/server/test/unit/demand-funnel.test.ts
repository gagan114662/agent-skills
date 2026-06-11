import { describe, it, expect } from "vitest";
import { aggregateFunnel, signalStrength } from "../../src/demand/signals.js";
import type { DemandSignal } from "../../src/demand/provenance.js";

function ext(signalClass: DemandSignal["signalClass"], ref: string, amountCents = 0): DemandSignal {
  return {
    signalClass,
    provenance: { kind: "externally_attributed", attribution: { source: "landing_visit", externalRef: ref } },
    amountCents,
    currency: "usd",
  };
}

function self(signalClass: DemandSignal["signalClass"]): DemandSignal {
  return { signalClass, provenance: { kind: "self_generated", generator: "bot" }, amountCents: 0, currency: "usd" };
}

describe("aggregateFunnel (visits → cta → checkout → paid)", () => {
  it("counts each externally-attributed stage and computes conversions", () => {
    const signals = [
      ...Array.from({ length: 100 }, (_, i) => ext("visit", `v${i}`)),
      ...Array.from({ length: 20 }, (_, i) => ext("cta_click", `c${i}`)),
      ...Array.from({ length: 8 }, (_, i) => ext("checkout_started", `s${i}`)),
      ...Array.from({ length: 4 }, (_, i) => ext("paid", `p${i}`, 2500)),
      ...Array.from({ length: 6 }, (_, i) => ext("waitlist", `w${i}`)),
    ];
    const f = aggregateFunnel(signals);
    expect(f.counts.visit).toBe(100);
    expect(f.counts.cta_click).toBe(20);
    expect(f.counts.checkout_started).toBe(8);
    expect(f.counts.paid).toBe(4);
    expect(f.counts.waitlist).toBe(6);
    expect(f.paidAmountCents).toBe(4 * 2500);
    expect(f.conversion.visitToCta).toBeCloseTo(0.2);
    expect(f.conversion.checkoutToPaid).toBeCloseTo(0.5);
    expect(f.conversion.visitToPaid).toBeCloseTo(0.04);
  });

  it("NEVER counts self-generated signals — circular evidence cannot inflate the funnel", () => {
    const signals = [ext("visit", "v1"), self("visit"), self("paid"), self("cta_click")];
    const f = aggregateFunnel(signals);
    expect(f.counts.visit).toBe(1);
    expect(f.counts.paid).toBe(0);
    expect(f.counts.cta_click).toBe(0);
  });

  it("returns zero conversions (not NaN) when a denominator stage is empty", () => {
    const f = aggregateFunnel([]);
    expect(f.conversion.visitToCta).toBe(0);
    expect(f.conversion.checkoutToPaid).toBe(0);
  });

  it("orders signal strength: paid is the strongest class, visit the weakest", () => {
    expect(signalStrength("paid")).toBeGreaterThan(signalStrength("checkout_started"));
    expect(signalStrength("checkout_started")).toBeGreaterThan(signalStrength("cta_click"));
    expect(signalStrength("cta_click")).toBeGreaterThan(signalStrength("visit"));
  });
});
