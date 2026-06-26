import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import { resolveCadenceCaps, isCadenceEnabledForWorkspace } from "../../src/cadence/caps.js";

/**
 * #416 — the cadence flag flows through the layered config (#58) and resolves DEFAULT-OFF, owner-first.
 * A deployment that sets nothing runs the cadence for nobody (the timer is never started). The env override
 * (RELOAD_CADENCE_*) turns it on for the named owner ONLY, and falls back to RELOAD_MARKETING_OWNER_WORKSPACE_ID.
 */
describe("cadence config flag (#416)", () => {
  it("defaults to an empty (all-off) block when nothing is configured", () => {
    const cfg = loadConfig("ws1", { env: {}, readFile: () => undefined });
    expect(cfg.cadence).toEqual({});
    const caps = resolveCadenceCaps(cfg.cadence);
    expect(caps.enabled).toBe(false);
    expect(caps.intervalMs).toBe(0);
    expect(isCadenceEnabledForWorkspace(caps, "ws1")).toBe(false);
  });

  it("parses a repo-layer block and runs for ONLY the named owner workspace", () => {
    const toml = [
      "[cadence]",
      "enabled = true",
      'ownerWorkspaceId = "owner-ws"',
      "intervalMs = 3600000",
      "maxLaunchesPerDay = 6",
      "",
    ].join("\n");
    const cfg = loadConfig("owner-ws", {
      env: {},
      readFile: (p) => (p.endsWith("settings.toml") ? toml : undefined),
      repoPath: "/x/.reload/settings.toml",
    });
    const caps = resolveCadenceCaps(cfg.cadence);
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceOnly).toBe(true);
    expect(caps.intervalMs).toBe(3_600_000);
    expect(caps.maxLaunchesPerDay).toBe(6);
    expect(isCadenceEnabledForWorkspace(caps, "owner-ws")).toBe(true);
    expect(isCadenceEnabledForWorkspace(caps, "someone-else")).toBe(false);
  });

  it("parses workspace cadence goals/OKRs from file-backed config (#522)", () => {
    const toml = [
      "[cadence]",
      "enabled = true",
      'ownerWorkspaceId = "owner-ws"',
      "",
      "[[cadence.goals]]",
      'objective = "Start three qualified customer conversations"',
      'keyResult = "3 replies from ICP founders"',
      'lead = "scout"',
      'outcomeKey = "conversations"',
      "",
    ].join("\n");
    const cfg = loadConfig("owner-ws", {
      env: {},
      readFile: (p) => (p.endsWith("settings.toml") ? toml : undefined),
      repoPath: "/x/.reload/settings.toml",
    });

    expect(cfg.cadence.goals).toEqual([
      {
        objective: "Start three qualified customer conversations",
        keyResult: "3 replies from ICP founders",
        lead: "scout",
        outcomeKey: "conversations",
      },
    ]);
  });

  it("turns the cadence on from deployment env (RELOAD_CADENCE_*) — ON for owner, OFF for others", () => {
    const env = {
      RELOAD_CADENCE_ENABLED: "true",
      RELOAD_CADENCE_OWNER_WORKSPACE_ID: "owner-ws",
      RELOAD_CADENCE_INTERVAL_MS: "1800000",
      RELOAD_CADENCE_MAX_PER_DAY: "8",
    };
    const cfg = loadConfig("owner-ws", { env, readFile: () => undefined });
    const caps = resolveCadenceCaps(cfg.cadence);
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceId).toBe("owner-ws");
    expect(caps.intervalMs).toBe(1_800_000);
    expect(caps.maxLaunchesPerDay).toBe(8);
    expect(isCadenceEnabledForWorkspace(caps, "owner-ws")).toBe(true);

    const other = loadConfig("customer-ws", { env, readFile: () => undefined });
    expect(isCadenceEnabledForWorkspace(resolveCadenceCaps(other.cadence), "customer-ws")).toBe(false);
  });

  it("falls back to RELOAD_MARKETING_OWNER_WORKSPACE_ID when the dedicated owner var is unset", () => {
    const cfg = loadConfig("owner-ws", {
      env: {
        RELOAD_CADENCE_ENABLED: "true",
        RELOAD_MARKETING_OWNER_WORKSPACE_ID: "owner-ws",
      },
      readFile: () => undefined,
    });
    const caps = resolveCadenceCaps(cfg.cadence);
    expect(caps.ownerWorkspaceId).toBe("owner-ws");
    expect(isCadenceEnabledForWorkspace(caps, "owner-ws")).toBe(true);
    expect(isCadenceEnabledForWorkspace(caps, "someone-else")).toBe(false);
  });

  it("the dedicated owner var overrides the marketing fallback", () => {
    const cfg = loadConfig("dedicated-ws", {
      env: {
        RELOAD_CADENCE_ENABLED: "true",
        RELOAD_CADENCE_OWNER_WORKSPACE_ID: "dedicated-ws",
        RELOAD_MARKETING_OWNER_WORKSPACE_ID: "marketing-ws",
      },
      readFile: () => undefined,
    });
    const caps = resolveCadenceCaps(cfg.cadence);
    expect(caps.ownerWorkspaceId).toBe("dedicated-ws");
    expect(isCadenceEnabledForWorkspace(caps, "dedicated-ws")).toBe(true);
    expect(isCadenceEnabledForWorkspace(caps, "marketing-ws")).toBe(false);
  });

  it("enabling WITHOUT naming an owner workspace runs for NOBODY", () => {
    const cfg = loadConfig("ws-x", {
      env: { RELOAD_CADENCE_ENABLED: "true" },
      readFile: () => undefined,
    });
    const caps = resolveCadenceCaps(cfg.cadence);
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceId).toBeUndefined();
    expect(isCadenceEnabledForWorkspace(caps, "ws-x")).toBe(false);
  });
});
