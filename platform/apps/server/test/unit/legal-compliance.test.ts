import { describe, it, expect } from "vitest";
import { decideCompliance } from "../../src/legal/compliance.js";
import type { ComplianceInput } from "../../src/legal/types.js";

const base: ComplianceInput = {
  kind: "email.send",
  target: "user@example.com",
  envelope: { footer: { unsubscribe: true, physicalAddress: "1 Main St, Townsville" }, consentBasis: "opt_in" },
  suppressed: false,
  hasConsent: true,
};
const opts = { requireConsent: true };

describe("decideCompliance — send-layer CAN-SPAM/CASL/GDPR (#196 criterion 2)", () => {
  it("allows a fully compliant marketing email", () => {
    const d = decideCompliance(base, opts);
    expect(d.allow).toBe(true);
    expect(d.reason).toBeNull();
    expect(d.rules).toEqual(["suppression", "can_spam_footer", "consent"]);
  });

  it("blocks a send to a suppressed recipient (highest precedence, overrides consent)", () => {
    const d = decideCompliance({ ...base, suppressed: true }, opts);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/suppression list/);
    expect(d.rules).toEqual(["suppression"]);
  });

  it("blocks a marketing email with no unsubscribe (CAN-SPAM)", () => {
    const d = decideCompliance({ ...base, envelope: { footer: { unsubscribe: false } } }, opts);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/unsubscribe/);
  });

  it("blocks a marketing email with no physical postal address (CAN-SPAM)", () => {
    const d = decideCompliance({ ...base, envelope: { footer: { unsubscribe: true } } }, opts);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/physical postal address/);
  });

  it("blocks an email with no lawful basis when consent is required (CASL/GDPR)", () => {
    const d = decideCompliance(
      { ...base, hasConsent: false, envelope: { footer: { unsubscribe: true, physicalAddress: "x" } } },
      opts,
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/lawful basis/);
  });

  it("accepts a declared contract/legitimate-interest basis without a consent record", () => {
    const d = decideCompliance(
      {
        ...base,
        hasConsent: false,
        envelope: { footer: { unsubscribe: true, physicalAddress: "x" }, consentBasis: "legitimate_interest" },
      },
      opts,
    );
    expect(d.allow).toBe(true);
  });

  it("skips the consent rule when requireConsent is off (footer still enforced)", () => {
    const d = decideCompliance({ ...base, hasConsent: false, envelope: { footer: { unsubscribe: true, physicalAddress: "x" } } }, { requireConsent: false });
    expect(d.allow).toBe(true);
    expect(d.rules).not.toContain("consent");
  });

  it("requires a named recipient for a per-recipient kind", () => {
    const d = decideCompliance({ ...base, target: "" }, opts);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/named recipient/);
  });

  it("checks suppression on social.post but not the email footer/consent", () => {
    expect(decideCompliance({ kind: "social.post", target: "@h", suppressed: false, hasConsent: false }, opts).allow).toBe(true);
    expect(decideCompliance({ kind: "social.post", target: "@h", suppressed: true, hasConsent: false }, opts).allow).toBe(false);
  });

  it("passes through non per-recipient kinds (ad.spend, content.publish, unknown)", () => {
    for (const kind of ["ad.spend", "content.publish", "whatever"]) {
      const d = decideCompliance({ kind, target: null, suppressed: true, hasConsent: false }, opts);
      expect(d.allow).toBe(true);
      expect(d.rules).toEqual([]);
    }
  });
});
