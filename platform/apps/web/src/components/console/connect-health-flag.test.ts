import { describe, it, expect } from "vitest";
import { shouldShowConnectHealth } from "./connect-health-flag.js";

/**
 * #365 — the connection-health chip gate. Pure + fail-closed: default-OFF, owner-workspace-first, so prod
 * (which sets no env) shows the chip to nobody. Mirrors the coordination-flag (#352) contract.
 */
const OWNER = "ws-owner";

describe("shouldShowConnectHealth (#365)", () => {
  it("is off when the flag is off (even for the named owner)", () => {
    expect(shouldShowConnectHealth({ flagOn: false, ownerWorkspaceId: OWNER, workspaceId: OWNER })).toBe(false);
  });

  it("is off when no current workspace is known", () => {
    expect(shouldShowConnectHealth({ flagOn: true, ownerWorkspaceId: OWNER, workspaceId: null })).toBe(false);
  });

  it("is off when no owner is named (named nobody = nobody)", () => {
    expect(shouldShowConnectHealth({ flagOn: true, ownerWorkspaceId: undefined, workspaceId: OWNER })).toBe(false);
    expect(shouldShowConnectHealth({ flagOn: true, ownerWorkspaceId: "  ", workspaceId: OWNER })).toBe(false);
  });

  it("is off for any workspace that is not the named owner", () => {
    expect(shouldShowConnectHealth({ flagOn: true, ownerWorkspaceId: OWNER, workspaceId: "ws-other" })).toBe(false);
  });

  it("shows ONLY for the named owner workspace when on", () => {
    expect(shouldShowConnectHealth({ flagOn: true, ownerWorkspaceId: OWNER, workspaceId: OWNER })).toBe(true);
    // tolerant of surrounding whitespace on both sides
    expect(shouldShowConnectHealth({ flagOn: true, ownerWorkspaceId: ` ${OWNER} `, workspaceId: ` ${OWNER} ` })).toBe(true);
  });
});
