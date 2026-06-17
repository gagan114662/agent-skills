import { describe, it, expect } from "vitest";
import { normalizeSha, decideReleaseAdvanced } from "../../src/runtime/release-verify.js";

/**
 * #292 — the deploy version-advance gate. Prod sat on VERSION 80 while CI was green, so the merged #247
 * model fix never reached users and the console threw "model isn't available". The cause: nothing verified
 * the running image actually CHANGED (`/readyz` passes on the old image too). These tests pin the pure,
 * fail-closed decision that the new `/version` gate is built on — premortem #200 FM#2 (real external
 * verification, never a fabricated pass) and FM#6 (the live `/version` body is untrusted DATA).
 */
describe("normalizeSha (#292 — untrusted /version body is bounded hex DATA, else null)", () => {
  it("accepts and canonicalizes a valid SHA (trim + lowercase)", () => {
    expect(normalizeSha("  ABC1234DEF\n")).toBe("abc1234def");
    expect(normalizeSha("0123456789abcdef0123456789abcdef01234567")).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
  });

  it("rejects anything that is not a 7–64 char hex string (injection guard, fails closed to null)", () => {
    expect(normalizeSha("")).toBeNull();
    expect(normalizeSha("abc123")).toBeNull(); // too short (< 7)
    expect(normalizeSha("g".repeat(8))).toBeNull(); // non-hex
    expect(normalizeSha("a".repeat(65))).toBeNull(); // too long (> 64)
    expect(normalizeSha("<html>error</html>")).toBeNull();
    expect(normalizeSha("abc1234; rm -rf /")).toBeNull();
    expect(normalizeSha(undefined)).toBeNull();
    expect(normalizeSha(null)).toBeNull();
    expect(normalizeSha(12345678)).toBeNull();
    expect(normalizeSha({ version: "abc1234" })).toBeNull();
  });
});

describe("decideReleaseAdvanced (#292 — fail-closed version-advance verdict)", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  const short = full.slice(0, 7);

  it("advances when the live SHA equals the deployed SHA", () => {
    const v = decideReleaseAdvanced({ expectedSha: full, liveSha: full });
    expect(v.advanced).toBe(true);
    expect(v.expected).toBe(full);
    expect(v.live).toBe(full);
  });

  it("advances when one side is an abbreviation of the other (either direction)", () => {
    expect(decideReleaseAdvanced({ expectedSha: full, liveSha: short }).advanced).toBe(true);
    expect(decideReleaseAdvanced({ expectedSha: short, liveSha: full }).advanced).toBe(true);
  });

  it("does NOT advance when the live host reports a different commit (the #292 stuck-on-old-image case)", () => {
    const other = "fedcba9876543210fedcba9876543210fedcba98";
    const v = decideReleaseAdvanced({ expectedSha: full, liveSha: other });
    expect(v.advanced).toBe(false);
    expect(v.reason).toMatch(/did NOT advance/);
  });

  it("fails closed when the live SHA is missing/empty (no /version, or an un-stamped old image)", () => {
    expect(decideReleaseAdvanced({ expectedSha: full, liveSha: "" }).advanced).toBe(false);
    expect(decideReleaseAdvanced({ expectedSha: full, liveSha: null }).advanced).toBe(false);
    const v = decideReleaseAdvanced({ expectedSha: full, liveSha: null });
    expect(v.reason).toMatch(/previous release|predates/i);
  });

  it("fails closed when the live SHA is malformed/untrusted, never trusting it as a match", () => {
    const v = decideReleaseAdvanced({ expectedSha: full, liveSha: "<html>503</html>" });
    expect(v.advanced).toBe(false);
    expect(v.live).toBeNull();
  });

  it("refuses to claim a pass when there is no valid expected SHA to verify against", () => {
    const v = decideReleaseAdvanced({ expectedSha: "", liveSha: full });
    expect(v.advanced).toBe(false);
    expect(v.reason).toMatch(/expected SHA/i);
  });

  it("never advances on a too-short prefix collision (the 7-char floor protects the comparison)", () => {
    // A 6-char string never normalizes, so it can't masquerade as a matching prefix.
    expect(decideReleaseAdvanced({ expectedSha: full, liveSha: "012345" }).advanced).toBe(false);
  });
});
