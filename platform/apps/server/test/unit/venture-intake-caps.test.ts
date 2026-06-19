import { describe, it, expect } from "vitest";
import {
  resolveVentureIntakeCaps,
  isOwnerWorkspace,
  ventureIntakeActive,
  VENTURE_INTAKE_DEFAULTS,
} from "../../src/venture-intake/caps.js";

describe("venture-intake/caps (#387)", () => {
  it("defaults OFF with no owner (fail-closed, owner-workspace-first)", () => {
    const caps = resolveVentureIntakeCaps(undefined);
    expect(caps).toEqual(VENTURE_INTAKE_DEFAULTS);
    expect(caps.enabled).toBe(false);
    expect(caps.ownerWorkspaceId).toBeNull();
  });

  it("applies overrides", () => {
    const caps = resolveVentureIntakeCaps({ enabled: true, ownerWorkspaceId: "ws-owner" });
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceId).toBe("ws-owner");
  });

  it("isOwnerWorkspace is fail-closed: named-nobody = nobody", () => {
    const off = resolveVentureIntakeCaps({ enabled: true });
    expect(isOwnerWorkspace(off, "any")).toBe(false); // enabled but no owner named ⇒ nobody
    const on = resolveVentureIntakeCaps({ enabled: true, ownerWorkspaceId: "ws-owner" });
    expect(isOwnerWorkspace(on, "ws-owner")).toBe(true);
    expect(isOwnerWorkspace(on, "ws-other")).toBe(false);
  });

  it("ventureIntakeActive requires BOTH enabled and owner match", () => {
    const enabledNoOwner = resolveVentureIntakeCaps({ enabled: true });
    expect(ventureIntakeActive(enabledNoOwner, "ws-owner")).toBe(false);
    const disabledOwner = resolveVentureIntakeCaps({ enabled: false, ownerWorkspaceId: "ws-owner" });
    expect(ventureIntakeActive(disabledOwner, "ws-owner")).toBe(false);
    const live = resolveVentureIntakeCaps({ enabled: true, ownerWorkspaceId: "ws-owner" });
    expect(ventureIntakeActive(live, "ws-owner")).toBe(true);
    expect(ventureIntakeActive(live, "ws-other")).toBe(false);
  });
});
