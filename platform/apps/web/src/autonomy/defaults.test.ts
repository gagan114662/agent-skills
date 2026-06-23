import { describe, expect, it } from "vitest";
import {
  AGENT_GARDEN_DEFAULT_ON,
  ALWAYS_ON_GUARDS,
  isAlwaysOnGuard,
  resolveGardenDisplay,
} from "./defaults.js";
import type { GardenAgentView } from "../api/types.js";

function agent(over: Partial<GardenAgentView>): GardenAgentView {
  return {
    handle: "scout",
    displayName: "Scout",
    title: "SEO",
    summary: "Audits your site.",
    capabilities: ["seo.audit"],
    costTier: "medium",
    riskTier: "read_only",
    priceLabel: "Standard compute",
    requiresApprovalToEnable: false,
    present: true,
    state: "disabled",
    active: false,
    inactiveReason: null,
    ...over,
  };
}

describe("autonomy garden defaults (#760)", () => {
  it("defaults every non-money capability ON when no preference is stored", () => {
    expect(AGENT_GARDEN_DEFAULT_ON).toBe(true);
    const d = resolveGardenDisplay(agent({ state: "disabled", active: false, userPreference: undefined }));
    expect(d).toEqual({ on: true, status: "on", approvalGated: false });
  });

  it("respects a persisted OFF preference (the opt-out) over the default", () => {
    const d = resolveGardenDisplay(agent({ userPreference: "off" }));
    expect(d).toEqual({ on: false, status: "off", approvalGated: false });
  });

  it("keeps an explicitly OFF money capability off but still marks it approval-gated", () => {
    const d = resolveGardenDisplay(
      agent({ riskTier: "external_send", requiresApprovalToEnable: true, userPreference: "off" }),
    );
    expect(d).toEqual({ on: false, status: "off", approvalGated: true });
  });

  it("presents a money capability ON-but-approval-gated by default — never auto-spend", () => {
    const d = resolveGardenDisplay(
      agent({ riskTier: "external_send", requiresApprovalToEnable: true, state: "disabled", active: false }),
    );
    expect(d).toEqual({ on: true, status: "on", approvalGated: true });
  });

  it("reads a parked (#13) money agent as pending and a seeded one as on", () => {
    expect(resolveGardenDisplay(agent({ state: "pending_approval", requiresApprovalToEnable: true }))).toEqual({
      on: true,
      status: "pending",
      approvalGated: true,
    });
    expect(resolveGardenDisplay(agent({ state: "enabled", active: true }))).toEqual({
      on: true,
      status: "on",
      approvalGated: false,
    });
    // Toggled on but its persona isn't seeded yet → "preparing", still on.
    expect(resolveGardenDisplay(agent({ state: "enabled", active: false }))).toEqual({
      on: true,
      status: "preparing",
      approvalGated: false,
    });
  });

  it("keeps the always-on guards out of the toggle set — a preference can never switch them off", () => {
    expect([...ALWAYS_ON_GUARDS]).toEqual(["kill-switch", "suppression", "anti-injection"]);
    for (const guard of ALWAYS_ON_GUARDS) expect(isAlwaysOnGuard(guard)).toBe(true);
    // A normal capability is never mistaken for a guard, so it remains an ordinary opt-out toggle.
    expect(isAlwaysOnGuard("seo.audit")).toBe(false);
    expect(isAlwaysOnGuard("publish")).toBe(false);
  });
});
