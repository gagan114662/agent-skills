import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import {
  resolveAgentCollaborationCaps,
  isSpawnEnabledForWorkspace,
} from "../../src/subagents/collaboration.js";

/**
 * #319 / #361 — the agent-collaboration (subagent-spawn) flag flows through the layered config (#58) and
 * resolves DEFAULT OFF, owner-workspace-first. This is the env override ADR-0352 §2 flagged as missing:
 * before this, `agentCollaboration` could only be set via the config/managed layer (unlike
 * `agentRegistry`/`durableWorkflow`). A deployment that sets nothing provisions spawn for nobody (today's
 * drafts-only tool surface stays), and enabling resolves ON for the named owner workspace ONLY.
 */
describe("agent-collaboration config flag (#319/#361)", () => {
  it("defaults to an empty (all-off) block when nothing is configured", () => {
    const cfg = loadConfig("ws1", { env: {}, readFile: () => undefined });
    expect(cfg.agentCollaboration).toEqual({});
    expect(
      isSpawnEnabledForWorkspace(resolveAgentCollaborationCaps(cfg.agentCollaboration), "ws1"),
    ).toBe(false);
  });

  it("parses a repo-layer block and provisions spawn for ONLY the named owner workspace", () => {
    const toml = ["[agentCollaboration]", "enabled = true", 'ownerWorkspaceId = "owner-ws"', ""].join(
      "\n",
    );
    const cfg = loadConfig("owner-ws", {
      env: {},
      readFile: (p) => (p.endsWith("settings.toml") ? toml : undefined),
      repoPath: "/x/.reload/settings.toml",
    });
    const caps = resolveAgentCollaborationCaps(cfg.agentCollaboration);
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceOnly).toBe(true); // owner-first default preserved
    expect(isSpawnEnabledForWorkspace(caps, "owner-ws")).toBe(true);
    expect(isSpawnEnabledForWorkspace(caps, "someone-else")).toBe(false);
  });

  it("turns the layer on from deployment env (RELOAD_AGENT_COLLABORATION_*) — ON for owner, OFF for others", () => {
    const cfg = loadConfig("owner-ws", {
      env: {
        RELOAD_AGENT_COLLABORATION_ENABLED: "true",
        RELOAD_AGENT_COLLABORATION_OWNER_WORKSPACE_ID: "owner-ws",
      },
      readFile: () => undefined,
    });
    const caps = resolveAgentCollaborationCaps(cfg.agentCollaboration);
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceId).toBe("owner-ws");
    expect(isSpawnEnabledForWorkspace(caps, "owner-ws")).toBe(true);
    // Any OTHER workspace stays OFF even with the same enabled env (owner-first, fail-closed).
    const other = loadConfig("customer-ws", {
      env: {
        RELOAD_AGENT_COLLABORATION_ENABLED: "true",
        RELOAD_AGENT_COLLABORATION_OWNER_WORKSPACE_ID: "owner-ws",
      },
      readFile: () => undefined,
    });
    expect(
      isSpawnEnabledForWorkspace(resolveAgentCollaborationCaps(other.agentCollaboration), "customer-ws"),
    ).toBe(false);
  });

  it("falls back to RELOAD_MARKETING_OWNER_WORKSPACE_ID when the dedicated owner var is unset (mirrors durableWorkflow)", () => {
    const cfg = loadConfig("owner-ws", {
      env: {
        RELOAD_AGENT_COLLABORATION_ENABLED: "true",
        RELOAD_MARKETING_OWNER_WORKSPACE_ID: "owner-ws",
      },
      readFile: () => undefined,
    });
    const caps = resolveAgentCollaborationCaps(cfg.agentCollaboration);
    expect(caps.ownerWorkspaceId).toBe("owner-ws");
    expect(isSpawnEnabledForWorkspace(caps, "owner-ws")).toBe(true);
    expect(isSpawnEnabledForWorkspace(caps, "someone-else")).toBe(false);
  });

  it("enabling WITHOUT naming an owner workspace provisions spawn for NOBODY (the safest default)", () => {
    const cfg = loadConfig("ws-x", {
      env: { RELOAD_AGENT_COLLABORATION_ENABLED: "true" },
      readFile: () => undefined,
    });
    const caps = resolveAgentCollaborationCaps(cfg.agentCollaboration);
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceId).toBeUndefined();
    expect(isSpawnEnabledForWorkspace(caps, "ws-x")).toBe(false);
  });

  it("the dedicated owner var overrides the marketing fallback", () => {
    const cfg = loadConfig("dedicated-ws", {
      env: {
        RELOAD_AGENT_COLLABORATION_ENABLED: "true",
        RELOAD_AGENT_COLLABORATION_OWNER_WORKSPACE_ID: "dedicated-ws",
        RELOAD_MARKETING_OWNER_WORKSPACE_ID: "marketing-ws",
      },
      readFile: () => undefined,
    });
    const caps = resolveAgentCollaborationCaps(cfg.agentCollaboration);
    expect(caps.ownerWorkspaceId).toBe("dedicated-ws");
    expect(isSpawnEnabledForWorkspace(caps, "dedicated-ws")).toBe(true);
    expect(isSpawnEnabledForWorkspace(caps, "marketing-ws")).toBe(false);
  });
});
