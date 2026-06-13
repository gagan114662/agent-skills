import { describe, it, expect } from "vitest";
import { resolveVerificationCaps, VERIFICATION_DEFAULTS } from "../../src/verification/caps.js";

describe("verification/caps", () => {
  it("defaults OFF with conservative rails when no config is set", () => {
    const caps = resolveVerificationCaps(undefined);
    expect(caps).toEqual(VERIFICATION_DEFAULTS);
    expect(caps.enabled).toBe(false);
    // auto-send must default OFF (a verified deliverable still waits for a human) and production
    // grounding must default ON (the premortem #3 final tier is required where it applies).
    expect(caps.autoSendReversible).toBe(false);
    expect(caps.requireProductionGrounding).toBe(true);
    expect(caps.maxRetries).toBeGreaterThanOrEqual(1);
    expect(caps.minConfidence).toBeGreaterThan(0);
  });

  it("applies explicit overrides over the defaults", () => {
    const caps = resolveVerificationCaps({
      enabled: true,
      minConfidence: 0.9,
      maxRetries: 5,
      autoSendReversible: true,
      requireProductionGrounding: false,
    });
    expect(caps).toEqual({
      enabled: true,
      minConfidence: 0.9,
      maxRetries: 5,
      autoSendReversible: true,
      requireProductionGrounding: false,
    });
  });
});
