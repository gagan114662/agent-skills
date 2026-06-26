import { describe, it, expect } from "vitest";
import {
  CADENCE_DEFAULTS,
  resolveCadenceCaps,
  isCadenceEnabledForWorkspace,
} from "../../src/cadence/caps.js";

/**
 * #416 — the cadence caps resolve DEFAULT-OFF, owner-workspace-first, with a hard per-day launch cap and a
 * default-0 (OFF) interval. `isCadenceEnabledForWorkspace` mirrors `isSpawnEnabledForWorkspace`: even when
 * enabled, an `ownerWorkspaceOnly` deployment runs ONLY for the named owner workspace; enabling without
 * naming the owner runs for nobody.
 */
describe("cadence caps (#416)", () => {
  it("defaults: OFF, owner-first, interval 0, per-day cap 12", () => {
    const caps = resolveCadenceCaps(undefined);
    expect(caps).toEqual(CADENCE_DEFAULTS);
    expect(caps.enabled).toBe(false);
    expect(caps.ownerWorkspaceOnly).toBe(true);
    expect(caps.ownerWorkspaceId).toBeUndefined();
    expect(caps.intervalMs).toBe(0);
    expect(caps.maxLaunchesPerDay).toBe(12);
  });

  it("an empty block resolves to the same hard defaults", () => {
    expect(resolveCadenceCaps({})).toEqual(CADENCE_DEFAULTS);
  });

  it("isCadenceEnabledForWorkspace: OFF by default for any workspace", () => {
    expect(isCadenceEnabledForWorkspace(resolveCadenceCaps({}), "owner-ws")).toBe(false);
  });

  it("enabled + owner-first: runs ONLY for the named owner workspace", () => {
    const caps = resolveCadenceCaps({ enabled: true, ownerWorkspaceId: "owner-ws" });
    expect(isCadenceEnabledForWorkspace(caps, "owner-ws")).toBe(true);
    expect(isCadenceEnabledForWorkspace(caps, "someone-else")).toBe(false);
  });

  it("enabled WITHOUT naming an owner workspace runs for NOBODY (safest default)", () => {
    const caps = resolveCadenceCaps({ enabled: true });
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceId).toBeUndefined();
    expect(isCadenceEnabledForWorkspace(caps, "any-ws")).toBe(false);
  });

  it("ownerWorkspaceOnly=false runs for every workspace once enabled", () => {
    const caps = resolveCadenceCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isCadenceEnabledForWorkspace(caps, "owner-ws")).toBe(true);
    expect(isCadenceEnabledForWorkspace(caps, "customer-ws")).toBe(true);
  });

  it("passes through explicit interval + per-day cap", () => {
    const caps = resolveCadenceCaps({ intervalMs: 3_600_000, maxLaunchesPerDay: 4 });
    expect(caps.intervalMs).toBe(3_600_000);
    expect(caps.maxLaunchesPerDay).toBe(4);
  });

  it("carries workspace goals/OKRs for the proactive cadence backlog (#522)", () => {
    const caps = resolveCadenceCaps({
      goals: [
        {
          objective: "Book three qualified founder calls",
          keyResult: "3 ICP conversations this week",
          lead: "scout",
          outcomeKey: "calls",
        },
      ],
    });

    expect(caps.goals).toEqual([
      {
        objective: "Book three qualified founder calls",
        keyResult: "3 ICP conversations this week",
        lead: "scout",
        outcomeKey: "calls",
      },
    ]);
  });
});
