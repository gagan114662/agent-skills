import { describe, it, expect } from "vitest";
import { resolveMoatCaps, MOAT_DEFAULTS, moatWeights } from "../../src/moat/caps.js";
import { MOAT_DIMENSIONS } from "../../src/moat/score.js";
import { mergeLayers } from "../../src/config/layers.js";

describe("resolveMoatCaps", () => {
  it("defaults to OFF with a 30-day window and equal weights", () => {
    const caps = resolveMoatCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.stagnationWindowDays).toBe(30);
    expect(MOAT_DEFAULTS.enabled).toBe(false);
    for (const d of MOAT_DIMENSIONS) expect(moatWeights(caps)[d]).toBe(1);
  });

  it("applies overrides from config", () => {
    const caps = resolveMoatCaps({
      enabled: true,
      stagnationWindowDays: 14,
      weightProprietaryData: 3,
      weightAccumulatedEvals: 0,
    });
    expect(caps.enabled).toBe(true);
    expect(caps.stagnationWindowDays).toBe(14);
    const w = moatWeights(caps);
    expect(w.proprietaryData).toBe(3);
    expect(w.accumulatedEvals).toBe(0);
    expect(w.switchingCosts).toBe(1); // unset → default
  });
});

describe("config layering wires the moat block", () => {
  it("resolves an empty moat block by default (present in mergeLayers)", () => {
    const resolved = mergeLayers([]);
    expect(resolved.moat).toEqual({});
  });

  it("lets a higher layer fully own the moat block (managed lock)", () => {
    const resolved = mergeLayers([
      { moat: { enabled: true, stagnationWindowDays: 7 } },
      { moat: { enabled: false } },
    ]);
    // Higher layer replaces (does not deep-merge) — so stagnationWindowDays is gone.
    expect(resolved.moat).toEqual({ enabled: false });
  });
});
