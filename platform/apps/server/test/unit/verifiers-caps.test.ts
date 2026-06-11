import { describe, it, expect } from "vitest";
import { resolveVerifierCaps, VERIFIER_DEFAULTS } from "../../src/verifiers/caps.js";

describe("verifiers/caps", () => {
  it("defaults OFF with the no-silent-pass rail on", () => {
    const caps = resolveVerifierCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.escalateOnFailure).toBe(true);
    expect(caps.maxPerTick).toBe(VERIFIER_DEFAULTS.maxPerTick);
  });

  it("applies config overrides", () => {
    const caps = resolveVerifierCaps({ enabled: true, escalateOnFailure: false, maxPerTick: 5 });
    expect(caps).toEqual({ enabled: true, escalateOnFailure: false, maxPerTick: 5 });
  });

  it("fills only the unset fields from defaults", () => {
    const caps = resolveVerifierCaps({ enabled: true });
    expect(caps.enabled).toBe(true);
    expect(caps.escalateOnFailure).toBe(true);
    expect(caps.maxPerTick).toBe(VERIFIER_DEFAULTS.maxPerTick);
  });
});
