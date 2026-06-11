import { describe, it, expect } from "vitest";
import {
  PAYING_INTENT_CLASSES,
  countUnaffiliatedPayingIntent,
} from "../../src/demand/signals.js";
import type { DemandSignal, DemandSignalClass } from "../../src/demand/provenance.js";

/** Build an externally-attributed signal with a given class + externalRef. */
function ext(signalClass: DemandSignalClass, externalRef: string): DemandSignal {
  return {
    signalClass,
    provenance: { kind: "externally_attributed", attribution: { source: "checkout", externalRef } },
    amountCents: signalClass === "paid" ? 5000 : 0,
    currency: "usd",
  };
}

/** Build a self-generated (circular) signal — must never be counted. */
function selfGen(signalClass: DemandSignalClass): DemandSignal {
  return {
    signalClass,
    provenance: { kind: "self_generated", generator: "advocate-persona" },
    amountCents: 0,
    currency: "usd",
  };
}

describe("countUnaffiliatedPayingIntent", () => {
  it("counts distinct externally-attributed paying-intent signals", () => {
    const signals = [
      ext("checkout_started", "ref-1"),
      ext("paid", "ref-2"),
      ext("waitlist", "ref-3"),
      ext("cta_click", "ref-4"),
    ];
    expect(countUnaffiliatedPayingIntent(signals)).toBe(4);
  });

  it("excludes passive visits (not paying-intent)", () => {
    const signals = [ext("visit", "v1"), ext("visit", "v2"), ext("paid", "p1")];
    expect(countUnaffiliatedPayingIntent(signals)).toBe(1);
  });

  it("excludes self-generated (circular) evidence — only unaffiliated strangers count", () => {
    const signals = [selfGen("paid"), selfGen("checkout_started"), ext("paid", "p1")];
    expect(countUnaffiliatedPayingIntent(signals)).toBe(1);
  });

  it("dedupes by externalRef — the same stranger acting twice is one signal", () => {
    const signals = [
      ext("checkout_started", "buyer-a"),
      ext("paid", "buyer-a"), // same external actor → not a second distinct buyer
      ext("paid", "buyer-b"),
    ];
    expect(countUnaffiliatedPayingIntent(signals)).toBe(2);
  });

  it("ignores externally-attributed signals with a blank externalRef (not attributable)", () => {
    const signals = [ext("paid", "  "), ext("paid", "real")];
    expect(countUnaffiliatedPayingIntent(signals)).toBe(1);
  });

  it("returns 0 for an empty signal set", () => {
    expect(countUnaffiliatedPayingIntent([])).toBe(0);
  });

  it("exposes the paying-intent classes (all active classes, never a passive visit)", () => {
    expect(PAYING_INTENT_CLASSES).toEqual(["cta_click", "checkout_started", "waitlist", "paid"]);
    expect(PAYING_INTENT_CLASSES).not.toContain("visit");
  });
});
