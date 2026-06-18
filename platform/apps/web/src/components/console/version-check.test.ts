/**
 * Pure web↔API version-parity tests (#366). Two contracts:
 *
 *  1. The surface gate is default-OFF, owner-workspace-first — identical to coordination-flag (#352) and
 *     connect-health-flag (#365): the mismatch banner shows ONLY when the flag is on AND a non-empty owner
 *     workspace is named AND the current workspace IS that owner. Every other branch is fail-closed.
 *
 *  2. {@link decideVersionParity} mirrors the #292 `decideReleaseAdvanced` discipline: untrusted SHAs are
 *     normalized to bounded hex (or null), and the verdict is FAIL-CLOSED to "unknown" whenever either side
 *     is missing/malformed — we only ever raise a "mismatch" when we have two valid, genuinely-divergent
 *     SHAs. A local/dev build (no stamp) is "unknown" and stays SILENT, never a false alarm.
 */
import { describe, expect, it } from "vitest";
import {
  decideVersionParity,
  normalizeSha,
  shouldShowVersionCheck,
  type VersionCheckGateInput,
} from "./version-check.js";

const owner = "ws_owner_123";
const on: VersionCheckGateInput = { flagOn: true, ownerWorkspaceId: owner, workspaceId: owner };

describe("shouldShowVersionCheck (#366 — default-OFF, owner-workspace-first)", () => {
  it("shows for the named owner workspace when the flag is on", () => {
    expect(shouldShowVersionCheck(on)).toBe(true);
  });

  it("is OFF by default — flag off shows for nobody, even the owner", () => {
    expect(shouldShowVersionCheck({ ...on, flagOn: false })).toBe(false);
  });

  it("hides from a non-owner workspace even when the flag is on (owner-first)", () => {
    expect(shouldShowVersionCheck({ ...on, workspaceId: "ws_someone_else" })).toBe(false);
  });

  it("naming nobody (no owner id) shows it to nobody, flag on or not", () => {
    expect(shouldShowVersionCheck({ flagOn: true, ownerWorkspaceId: undefined, workspaceId: owner })).toBe(false);
    expect(shouldShowVersionCheck({ flagOn: true, ownerWorkspaceId: "", workspaceId: owner })).toBe(false);
    expect(shouldShowVersionCheck({ flagOn: true, ownerWorkspaceId: "   ", workspaceId: owner })).toBe(false);
  });

  it("hides when there is no current workspace, even for a named owner", () => {
    expect(shouldShowVersionCheck({ flagOn: true, ownerWorkspaceId: owner, workspaceId: null })).toBe(false);
    expect(shouldShowVersionCheck({ flagOn: true, ownerWorkspaceId: owner, workspaceId: "" })).toBe(false);
  });

  it("matches owner vs workspace after trimming surrounding whitespace", () => {
    expect(shouldShowVersionCheck({ flagOn: true, ownerWorkspaceId: ` ${owner} `, workspaceId: `${owner} ` })).toBe(
      true,
    );
    expect(shouldShowVersionCheck({ flagOn: true, ownerWorkspaceId: owner, workspaceId: `${owner}x` })).toBe(false);
  });
});

describe("normalizeSha (#366/#292 — untrusted /version body is bounded hex DATA, else null)", () => {
  it("accepts and canonicalizes a valid SHA (trim + lowercase)", () => {
    expect(normalizeSha("  ABC1234DEF\n")).toBe("abc1234def");
  });

  it("rejects anything that is not a 7–64 char hex string (injection guard, fails closed to null)", () => {
    expect(normalizeSha("")).toBeNull();
    expect(normalizeSha("abc123")).toBeNull(); // too short (< 7)
    expect(normalizeSha("g".repeat(8))).toBeNull(); // non-hex
    expect(normalizeSha("a".repeat(65))).toBeNull(); // too long (> 64)
    expect(normalizeSha("<html>error</html>")).toBeNull();
    expect(normalizeSha(undefined)).toBeNull();
    expect(normalizeSha(null)).toBeNull();
    expect(normalizeSha(12345678)).toBeNull();
  });
});

describe("decideVersionParity (#366 — fail-closed web↔API parity verdict)", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  const short = full.slice(0, 7);

  it("matches when web and API report the same commit", () => {
    const v = decideVersionParity({ webSha: full, apiSha: full });
    expect(v.status).toBe("match");
    expect(v.web).toBe(full);
    expect(v.api).toBe(full);
  });

  it("matches across abbreviation (one side short-hash of the other)", () => {
    expect(decideVersionParity({ webSha: short, apiSha: full }).status).toBe("match");
    expect(decideVersionParity({ webSha: full, apiSha: short }).status).toBe("match");
  });

  it("reports MISMATCH only when both SHAs are valid and genuinely divergent", () => {
    const other = "fedcba9876543210fedcba9876543210fedcba98";
    const v = decideVersionParity({ webSha: full, apiSha: other });
    expect(v.status).toBe("mismatch");
    expect(v.web).toBe(full);
    expect(v.api).toBe(other);
  });

  it("is UNKNOWN (silent, never a false alarm) when the web build is unstamped", () => {
    expect(decideVersionParity({ webSha: "", apiSha: full }).status).toBe("unknown");
    expect(decideVersionParity({ webSha: undefined, apiSha: full }).status).toBe("unknown");
  });

  it("is UNKNOWN when the API reports no/garbage version (the #292 unstamped-host case)", () => {
    expect(decideVersionParity({ webSha: full, apiSha: "" }).status).toBe("unknown");
    expect(decideVersionParity({ webSha: full, apiSha: "<html>502</html>" }).status).toBe("unknown");
    expect(decideVersionParity({ webSha: full, apiSha: null }).status).toBe("unknown");
  });
});
