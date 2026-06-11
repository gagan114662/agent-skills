import { describe, it, expect } from "vitest";
import { evaluateExperiment, validateSpec, ExperimentSpecError, type ExperimentSpec } from "../../src/demand/experiment.js";
import { aggregateFunnel } from "../../src/demand/signals.js";
import type { DemandSignal } from "../../src/demand/provenance.js";

function ext(signalClass: DemandSignal["signalClass"], ref: string): DemandSignal {
  return {
    signalClass,
    provenance: { kind: "externally_attributed", attribution: { source: "landing_visit", externalRef: ref } },
    amountCents: 0,
    currency: "usd",
  };
}

/** Default locked spec: ≥5% of visitors must pay, ≥50 visitors, window [1000, 2000). */
function spec(over: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    hypothesis: "Strangers will pay for X",
    successClass: "paid",
    denominatorClass: "visit",
    passThreshold: 0.05,
    minSample: 50,
    windowStartMs: 1000,
    windowEndMs: 2000,
    ...over,
  };
}

function funnel(visits: number, paid: number) {
  const signals = [
    ...Array.from({ length: visits }, (_, i) => ext("visit", `v${i}`)),
    ...Array.from({ length: paid }, (_, i) => ext("paid", `p${i}`)),
  ];
  return aggregateFunnel(signals);
}

describe("evaluateExperiment (locked bar, anti-p-hacking)", () => {
  it("is PENDING while the window is open — no early/optional stopping even if already passing", () => {
    const r = evaluateExperiment(spec(), funnel(60, 30), 1500); // 50% conversion, plenty of sample
    expect(r.status).toBe("PENDING");
  });

  it("PASSes once the window closes with enough sample and the conversion clears the locked bar", () => {
    const r = evaluateExperiment(spec(), funnel(60, 6), 2000); // 10% ≥ 5%, 60 ≥ 50
    expect(r.status).toBe("PASS");
    expect(r.conversion).toBeCloseTo(0.1);
  });

  it("FAILs when the window closed with enough sample but the conversion misses the bar", () => {
    const r = evaluateExperiment(spec(), funnel(100, 2), 2000); // 2% < 5%
    expect(r.status).toBe("FAIL");
  });

  it("is INCONCLUSIVE (never PASS) when the sample is below the minimum after the window closes", () => {
    const r = evaluateExperiment(spec(), funnel(3, 3), 2500); // 100% conversion but only 3 visitors
    expect(r.status).toBe("INCONCLUSIVE");
  });

  it("reads the LOCKED threshold — mutating the bar after data cannot turn a FAIL into a PASS", () => {
    const f = funnel(100, 2); // 2% conversion
    expect(evaluateExperiment(spec({ passThreshold: 0.05 }), f, 2000).status).toBe("FAIL");
    // The persisted spec is what evaluate sees; the service never lets a launched spec's bar change.
    expect(evaluateExperiment(spec({ passThreshold: 0.01 }), f, 2000).status).toBe("PASS");
  });
});

describe("validateSpec (the bar must be well-formed before launch)", () => {
  it("rejects a non-probability threshold", () => {
    expect(() => validateSpec(spec({ passThreshold: 0 }))).toThrow(ExperimentSpecError);
    expect(() => validateSpec(spec({ passThreshold: 1.5 }))).toThrow(ExperimentSpecError);
  });
  it("rejects a non-positive minimum sample", () => {
    expect(() => validateSpec(spec({ minSample: 0 }))).toThrow(ExperimentSpecError);
  });
  it("rejects an inverted/empty window", () => {
    expect(() => validateSpec(spec({ windowStartMs: 2000, windowEndMs: 1000 }))).toThrow(ExperimentSpecError);
  });
  it("accepts a well-formed spec", () => {
    expect(() => validateSpec(spec())).not.toThrow();
  });
});
