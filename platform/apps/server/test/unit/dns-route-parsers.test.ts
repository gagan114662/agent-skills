import { describe, it, expect } from "vitest";
import { parseDkim, parseStringArray } from "../../src/routes/onboarding.js";

/**
 * #264 review hardening: the DNS route body parsers must TRIM and REJECT blank values so a non-technical
 * user can never push a malformed SPF/DKIM record into their zone (e.g. `._domainkey`, `p=`, or
 * `v=spf1 include: ~all`).
 */

describe("parseDkim (#264 — reject blank selector/publicKey)", () => {
  it("trims a valid selector + public key", () => {
    expect(parseDkim({ selector: "  s1  ", publicKey: " PUB " })).toEqual({ selector: "s1", publicKey: "PUB" });
  });

  it("rejects blank/whitespace-only selector or public key", () => {
    expect(parseDkim({ selector: "   ", publicKey: "PUB" })).toBeUndefined();
    expect(parseDkim({ selector: "s1", publicKey: "  " })).toBeUndefined();
    expect(parseDkim({ selector: "", publicKey: "" })).toBeUndefined();
  });

  it("rejects non-string or missing fields", () => {
    expect(parseDkim({ selector: 1, publicKey: "PUB" })).toBeUndefined();
    expect(parseDkim({ selector: "s1" })).toBeUndefined();
    expect(parseDkim(null)).toBeUndefined();
    expect(parseDkim("nope")).toBeUndefined();
  });
});

describe("parseStringArray (#264 — drop blank SPF includes)", () => {
  it("trims each value and drops empty/whitespace-only entries", () => {
    expect(parseStringArray(["  sendgrid.net ", "", "   ", "spf.example.com"])).toEqual([
      "sendgrid.net",
      "spf.example.com",
    ]);
  });

  it("drops non-strings and returns [] when every entry is blank", () => {
    expect(parseStringArray(["valid", 42, null, "  "])).toEqual(["valid"]);
    expect(parseStringArray(["   ", ""])).toEqual([]);
  });

  it("returns undefined for a non-array", () => {
    expect(parseStringArray(undefined)).toBeUndefined();
    expect(parseStringArray("sendgrid.net")).toBeUndefined();
  });
});
