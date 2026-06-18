import { describe, it, expect } from "vitest";
import {
  decidePassport,
  isAllowedIdpProvider,
  type IdpAssertion,
  type PassportInput,
} from "../../src/enterprise/passport.js";

const CTRL = String.fromCharCode(7); // BEL — a control char without a literal control byte in source

function input(over: Partial<PassportInput> = {}): PassportInput {
  return {
    enabled: true,
    identityPresent: true,
    assertion: { provider: "google", subject: "user-1", verified: true },
    allowedProviders: ["google", "okta"],
    ...over,
  };
}

describe("enterprise passport — IdP/SSO gating, default-off (#340)", () => {
  it("when the gate is OFF it is a pass-through (open) — adds no requirement", () => {
    const d = decidePassport(input({ enabled: false, assertion: null }));
    expect(d.status).toBe("open");
    expect(d.allow).toBe(true);
  });

  it("when ON, an allowed + verified IdP assertion is admitted", () => {
    const d = decidePassport(input());
    expect(d.allow).toBe(true);
    expect(d.status).toBe("authenticated");
  });

  it("when ON, an unauthenticated caller is denied (nothing internal is publicly exposed)", () => {
    const d = decidePassport(input({ identityPresent: false, assertion: null }));
    expect(d.allow).toBe(false);
    expect(d.status).toBe("unauthenticated");
  });

  it("when ON, an authenticated session WITHOUT an SSO assertion is denied (sso_required)", () => {
    const d = decidePassport(input({ assertion: null }));
    expect(d.allow).toBe(false);
    expect(d.status).toBe("sso_required");
  });

  it("when ON, a present-but-UNVERIFIED assertion is denied (sso_required) — verified must be real", () => {
    const d = decidePassport(input({ assertion: { provider: "google", subject: "u", verified: false } }));
    expect(d.allow).toBe(false);
    expect(d.status).toBe("sso_required");
  });

  it("when ON, a verified assertion from a NON-allow-listed IdP is denied (forbidden_idp)", () => {
    const d = decidePassport(input({ assertion: { provider: "evilcorp", subject: "u", verified: true } }));
    expect(d.allow).toBe(false);
    expect(d.status).toBe("forbidden_idp");
  });

  it("an empty allow-list with the gate ON locks everything out (fully dark)", () => {
    const d = decidePassport(input({ allowedProviders: [] }));
    expect(d.allow).toBe(false);
    expect(d.status).toBe("forbidden_idp");
  });
});

describe("enterprise passport — allow-list normalization + injection defense (#200 §6)", () => {
  it("matches the provider case-insensitively and trims whitespace", () => {
    expect(isAllowedIdpProvider("  GOOGLE ", ["google"])).toBe(true);
    expect(isAllowedIdpProvider("Okta", ["google", "okta"])).toBe(true);
  });

  it("a provider carrying control characters never matches the allow-list", () => {
    expect(isAllowedIdpProvider(`google${CTRL}`, ["google"])).toBe(false);
  });

  it("a forged verified=true with a junk/poisoned provider is rejected by the allow-list", () => {
    const assertion: IdpAssertion = { provider: `google${CTRL}<script>`, subject: "u", verified: true };
    const d = decidePassport(input({ assertion }));
    expect(d.allow).toBe(false);
    expect(d.status).toBe("forbidden_idp");
  });

  it("a non-string / empty provider never matches", () => {
    expect(isAllowedIdpProvider("", ["google"])).toBe(false);
    expect(isAllowedIdpProvider(undefined as unknown as string, ["google"])).toBe(false);
  });
});
