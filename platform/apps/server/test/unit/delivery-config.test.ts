import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import { resolveDeliveryFlags, DELIVERY_FLAGS_OFF } from "../../src/delivery/decide.js";

/**
 * #295 — the delivery flag flows through the layered config (#58) and resolves DEFAULT OFF,
 * owner-workspace-first. A deployment that sets nothing ships nothing.
 */
describe("delivery config flag (#295)", () => {
  it("defaults to an empty (all-off) delivery block when nothing is configured", () => {
    const cfg = loadConfig("ws1", { env: {}, readFile: () => undefined });
    expect(cfg.delivery).toEqual({});
    expect(resolveDeliveryFlags(cfg.delivery, "ws1")).toEqual(DELIVERY_FLAGS_OFF);
  });

  it("parses a repo-layer delivery block and enables ONLY the named owner workspace", () => {
    const toml = [
      "[delivery]",
      "enabled = true",
      "publish = true",
      'ownerWorkspaceId = "owner-ws"',
      "",
    ].join("\n");
    const cfg = loadConfig("owner-ws", {
      env: {},
      readFile: (p) => (p.endsWith("settings.toml") ? toml : undefined),
      repoPath: "/x/.reload/settings.toml",
    });
    expect(resolveDeliveryFlags(cfg.delivery, "owner-ws")).toMatchObject({ enabled: true, publish: true });
    // a different workspace, same config → still off (owner-workspace-first)
    expect(resolveDeliveryFlags(cfg.delivery, "someone-else")).toEqual(DELIVERY_FLAGS_OFF);
  });

  it("parses the site_pr channel flag owner-workspace-first (#364)", () => {
    const toml = [
      "[delivery]",
      "enabled = true",
      "sitePr = true",
      'ownerWorkspaceId = "owner-ws"',
      "",
    ].join("\n");
    const cfg = loadConfig("owner-ws", {
      env: {},
      readFile: (p) => (p.endsWith("settings.toml") ? toml : undefined),
      repoPath: "/x/.reload/settings.toml",
    });
    expect(resolveDeliveryFlags(cfg.delivery, "owner-ws")).toMatchObject({ enabled: true, site_pr: true });
    expect(resolveDeliveryFlags(cfg.delivery, "someone-else")).toEqual(DELIVERY_FLAGS_OFF);
  });
});
