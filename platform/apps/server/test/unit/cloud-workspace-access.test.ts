import { describe, it, expect } from "vitest";
import { effectiveCloudWorkspaceCapability, satisfies } from "../../src/auth/access.js";

describe("cloud workspace sharing — effective capability (#55, #9 ladder)", () => {
  it("the owner always holds propagate (implicit admin)", () => {
    expect(effectiveCloudWorkspaceCapability(true, null)).toBe("propagate");
    // owner wins even over a downgraded collaborator row
    expect(effectiveCloudWorkspaceCapability(true, { capability: "read", revokedAt: null })).toBe(
      "propagate",
    );
  });

  it("an active collaborator gets exactly their granted capability", () => {
    expect(effectiveCloudWorkspaceCapability(false, { capability: "read", revokedAt: null })).toBe(
      "read",
    );
    expect(effectiveCloudWorkspaceCapability(false, { capability: "write", revokedAt: null })).toBe(
      "write",
    );
  });

  it("a non-collaborator and a revoked collaborator have no access", () => {
    expect(effectiveCloudWorkspaceCapability(false, null)).toBeNull();
    expect(
      effectiveCloudWorkspaceCapability(false, { capability: "write", revokedAt: new Date() }),
    ).toBeNull();
  });

  it("the ladder gates needed levels (read < write < propagate)", () => {
    const collab = effectiveCloudWorkspaceCapability(false, { capability: "read", revokedAt: null });
    expect(collab && satisfies(collab, "read")).toBe(true);
    expect(collab && satisfies(collab, "write")).toBe(false); // read cannot write
  });
});
