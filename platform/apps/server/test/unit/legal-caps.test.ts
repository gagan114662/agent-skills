import { describe, it, expect } from "vitest";
import { resolveLegalCaps, LEGAL_DEFAULTS } from "../../src/legal/caps.js";
import { DOCUMENT_DISCLAIMER, AGENT_LEGAL_DISCLAIMER } from "../../src/legal/disclaimer.js";

describe("resolveLegalCaps (#196) — default OFF", () => {
  it("an unset legal block resolves to the hard defaults", () => {
    expect(resolveLegalCaps(undefined)).toEqual(LEGAL_DEFAULTS);
    expect(resolveLegalCaps({})).toEqual(LEGAL_DEFAULTS);
  });

  it("the pack is OFF by default (risky capability gated; owner opts in)", () => {
    expect(LEGAL_DEFAULTS.enabled).toBe(false);
    expect(LEGAL_DEFAULTS.autoRegenerate).toBe(false);
  });

  it("honors explicit overrides", () => {
    expect(resolveLegalCaps({ enabled: true, autoRegenerate: true, requireConsentForEmail: false })).toEqual({
      enabled: true,
      autoRegenerate: true,
      requireConsentForEmail: false,
    });
  });
});

describe("disclaimer rails (#196 criterion 5)", () => {
  it("the document disclaimer states it is not legal advice / not counsel", () => {
    expect(DOCUMENT_DISCLAIMER.toLowerCase()).toContain("not legal advice");
    expect(DOCUMENT_DISCLAIMER.toLowerCase()).toContain("attorney");
  });
  it("the agent rail labels output as a draft, not advice", () => {
    expect(AGENT_LEGAL_DISCLAIMER.toLowerCase()).toContain("not legal advice");
  });
});
