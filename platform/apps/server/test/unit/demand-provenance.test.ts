import { describe, it, expect } from "vitest";
import {
  externalDemandEvidence,
  assertExternalDemandEvidence,
  isExternallyAttributed,
  CircularEvidenceError,
  type DemandSignal,
} from "../../src/demand/provenance.js";

/** A real stranger's checkout — externally attributed, carries an externalRef from outside the building. */
function externalSignal(over: Partial<DemandSignal> = {}): DemandSignal {
  return {
    signalClass: "paid",
    provenance: { kind: "externally_attributed", attribution: { source: "checkout", externalRef: "evt_123" } },
    amountCents: 2000,
    currency: "usd",
    ...over,
  };
}

/** An LLM persona / heuristic — self-generated, the circular evidence the demand dimension must refuse. */
function selfGeneratedSignal(over: Partial<DemandSignal> = {}): DemandSignal {
  return {
    signalClass: "paid",
    provenance: { kind: "self_generated", generator: "advocate-persona" },
    amountCents: 2000,
    currency: "usd",
    ...over,
  };
}

describe("demand provenance (typed self-vs-external separation)", () => {
  it("constructs ExternalDemandEvidence from an externally-attributed signal", () => {
    const ev = externalDemandEvidence(externalSignal());
    expect(ev).not.toBeNull();
    expect(ev!.signalClass).toBe("paid");
  });

  it("REFUSES to construct evidence from a self-generated signal (circular) — returns null", () => {
    expect(externalDemandEvidence(selfGeneratedSignal())).toBeNull();
  });

  it("assertExternalDemandEvidence throws CircularEvidenceError on a self-generated signal", () => {
    expect(() => assertExternalDemandEvidence(selfGeneratedSignal())).toThrow(CircularEvidenceError);
    // and is the identity (branded) on a real external signal
    expect(assertExternalDemandEvidence(externalSignal()).amountCents).toBe(2000);
  });

  it("isExternallyAttributed narrows the provenance union", () => {
    expect(isExternallyAttributed({ kind: "externally_attributed", attribution: { source: "checkout", externalRef: "e" } })).toBe(true);
    expect(isExternallyAttributed({ kind: "self_generated", generator: "x" })).toBe(false);
  });

  it("treats an externally-attributed signal with a blank externalRef as NOT attributable (no proof)", () => {
    const blank = externalSignal({
      provenance: { kind: "externally_attributed", attribution: { source: "checkout", externalRef: "  " } },
    });
    expect(externalDemandEvidence(blank)).toBeNull();
  });
});
