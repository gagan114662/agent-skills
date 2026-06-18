import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import {
  resolveDurableWorkflowCaps,
  isDurableWorkflowEnabledForWorkspace,
} from "../../src/durable-workflow/caps.js";

/**
 * #338 — the durable-workflow flag flows through the layered config (#58) and resolves DEFAULT OFF,
 * owner-workspace-first. A deployment that sets nothing routes nobody (the legacy in-process poll stays).
 */
describe("durable-workflow config flag (#338)", () => {
  it("defaults to an empty (all-off) block when nothing is configured", () => {
    const cfg = loadConfig("ws1", { env: {}, readFile: () => undefined });
    expect(cfg.durableWorkflow).toEqual({});
    expect(isDurableWorkflowEnabledForWorkspace(resolveDurableWorkflowCaps(cfg.durableWorkflow), "ws1")).toBe(
      false,
    );
  });

  it("parses a repo-layer block and routes ONLY the named owner workspace", () => {
    const toml = [
      "[durableWorkflow]",
      "enabled = true",
      'ownerWorkspaceId = "owner-ws"',
      "maxAttempts = 12",
      "",
    ].join("\n");
    const cfg = loadConfig("owner-ws", {
      env: {},
      readFile: (p) => (p.endsWith("settings.toml") ? toml : undefined),
      repoPath: "/x/.reload/settings.toml",
    });
    const caps = resolveDurableWorkflowCaps(cfg.durableWorkflow);
    expect(caps.enabled).toBe(true);
    expect(caps.maxAttempts).toBe(12);
    expect(isDurableWorkflowEnabledForWorkspace(caps, "owner-ws")).toBe(true);
    expect(isDurableWorkflowEnabledForWorkspace(caps, "someone-else")).toBe(false);
  });

  it("turns the layer on from deployment env (RELOAD_DURABLE_WORKFLOW_*)", () => {
    const cfg = loadConfig("owner-ws", {
      env: {
        RELOAD_DURABLE_WORKFLOW_ENABLED: "true",
        RELOAD_DURABLE_WORKFLOW_OWNER_WORKSPACE_ID: "owner-ws",
      },
      readFile: () => undefined,
    });
    const caps = resolveDurableWorkflowCaps(cfg.durableWorkflow);
    expect(caps.enabled).toBe(true);
    expect(isDurableWorkflowEnabledForWorkspace(caps, "owner-ws")).toBe(true);
    // Enabling without naming an owner → routes nobody (the env owner marker is required).
    const noOwner = loadConfig("ws-x", {
      env: { RELOAD_DURABLE_WORKFLOW_ENABLED: "true" },
      readFile: () => undefined,
    });
    expect(
      isDurableWorkflowEnabledForWorkspace(resolveDurableWorkflowCaps(noOwner.durableWorkflow), "ws-x"),
    ).toBe(false);
  });
});
