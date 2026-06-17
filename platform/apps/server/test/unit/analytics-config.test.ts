import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import { resolveAnalyticsFlags, ANALYTICS_FLAGS_OFF } from "../../src/analytics/decide.js";

/**
 * #270 — the analytics flag flows through the layered config (#58) and resolves DEFAULT OFF,
 * owner-workspace-first. A deployment that sets nothing installs nothing and reads nothing.
 */
describe("analytics config flag (#270)", () => {
  it("defaults to an empty (all-off) analytics block when nothing is configured", () => {
    const cfg = loadConfig("ws1", { env: {}, readFile: () => undefined });
    expect(cfg.analytics).toEqual({});
    expect(resolveAnalyticsFlags(cfg.analytics, "ws1")).toEqual(ANALYTICS_FLAGS_OFF);
  });

  it("parses a repo-layer analytics block and enables ONLY the named owner workspace", () => {
    const toml = [
      "[analytics]",
      "enabled = true",
      'provider = "ga4"',
      'measurementId = "G-ABC123"',
      'ownerWorkspaceId = "owner-ws"',
      "",
    ].join("\n");
    const cfg = loadConfig("owner-ws", {
      env: {},
      readFile: (p) => (p.endsWith("settings.toml") ? toml : undefined),
      repoPath: "/x/.reload/settings.toml",
    });
    expect(resolveAnalyticsFlags(cfg.analytics, "owner-ws")).toMatchObject({
      enabled: true,
      provider: "ga4",
      measurementId: "G-ABC123",
    });
    // a different workspace, same config → still off (owner-workspace-first)
    expect(resolveAnalyticsFlags(cfg.analytics, "someone-else")).toEqual(ANALYTICS_FLAGS_OFF);
  });

  it("turns the layer on from deployment env (RELOAD_ANALYTICS_*)", () => {
    const cfg = loadConfig("owner-ws", {
      env: {
        RELOAD_ANALYTICS_ENABLED: "true",
        RELOAD_ANALYTICS_PROVIDER: "plausible",
        RELOAD_ANALYTICS_MEASUREMENT_ID: "ipop.ai",
        RELOAD_ANALYTICS_OWNER_WORKSPACE_ID: "owner-ws",
      },
      readFile: () => undefined,
    });
    expect(resolveAnalyticsFlags(cfg.analytics, "owner-ws")).toMatchObject({
      enabled: true,
      provider: "plausible",
      measurementId: "ipop.ai",
    });
  });
});
