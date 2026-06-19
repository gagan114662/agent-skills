import { describe, it, expect } from "vitest";
import {
  resolveAttributionCaps,
  isOwnerWorkspace,
  attributionActive,
  maxChainAgeMs,
  ATTRIBUTION_DEFAULTS,
} from "../../src/attribution/caps.js";

describe("attribution/caps", () => {
  it("defaults OFF with no owner (fail-closed, owner-workspace-first)", () => {
    const caps = resolveAttributionCaps(undefined);
    expect(caps).toEqual(ATTRIBUTION_DEFAULTS);
    expect(caps.enabled).toBe(false);
    expect(caps.ownerWorkspaceId).toBeNull();
  });

  it("applies overrides and keeps hard defaults for the rest", () => {
    const caps = resolveAttributionCaps({ enabled: true, ownerWorkspaceId: "ws-owner" });
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceId).toBe("ws-owner");
    expect(caps.maxChainAgeDays).toBe(ATTRIBUTION_DEFAULTS.maxChainAgeDays);
  });

  it("isOwnerWorkspace is fail-closed: named-nobody = nobody", () => {
    const off = resolveAttributionCaps({ enabled: true });
    expect(isOwnerWorkspace(off, "any")).toBe(false); // no owner named ⇒ nobody
    const on = resolveAttributionCaps({ enabled: true, ownerWorkspaceId: "ws-owner" });
    expect(isOwnerWorkspace(on, "ws-owner")).toBe(true);
    expect(isOwnerWorkspace(on, "ws-other")).toBe(false);
  });

  it("attributionActive requires BOTH enabled and owner match", () => {
    const enabledNoOwner = resolveAttributionCaps({ enabled: true });
    expect(attributionActive(enabledNoOwner, "ws-owner")).toBe(false);
    const disabledOwner = resolveAttributionCaps({ enabled: false, ownerWorkspaceId: "ws-owner" });
    expect(attributionActive(disabledOwner, "ws-owner")).toBe(false);
    const live = resolveAttributionCaps({ enabled: true, ownerWorkspaceId: "ws-owner" });
    expect(attributionActive(live, "ws-owner")).toBe(true);
  });

  it("maxChainAgeMs converts days to ms", () => {
    const caps = resolveAttributionCaps({ maxChainAgeDays: 1 });
    expect(maxChainAgeMs(caps)).toBe(86_400_000);
  });
});
