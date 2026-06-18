import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import {
  resolveAgentChannelPostingCaps,
  isAgentChannelPostingEnabledForWorkspace,
} from "../../src/agent-channel-bridge/caps.js";

/**
 * #370 — the agent→channel posting flag flows through the layered config (#58) and resolves DEFAULT OFF,
 * owner-workspace-first. A deployment that sets nothing posts for nobody (today's channels stay quiet).
 */
describe("agent→channel posting config flag (#370)", () => {
  it("defaults to an empty (all-off) block when nothing is configured", () => {
    const cfg = loadConfig("ws1", { env: {}, readFile: () => undefined });
    expect(cfg.agentChannelPosting).toEqual({});
    expect(
      isAgentChannelPostingEnabledForWorkspace(
        resolveAgentChannelPostingCaps(cfg.agentChannelPosting),
        "ws1",
      ),
    ).toBe(false);
  });

  it("parses a repo-layer block and posts for ONLY the named owner workspace", () => {
    const toml = ["[agentChannelPosting]", "enabled = true", 'ownerWorkspaceId = "owner-ws"', ""].join(
      "\n",
    );
    const cfg = loadConfig("owner-ws", {
      env: {},
      readFile: (p) => (p.endsWith("settings.toml") ? toml : undefined),
      repoPath: "/x/.reload/settings.toml",
    });
    const caps = resolveAgentChannelPostingCaps(cfg.agentChannelPosting);
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceOnly).toBe(true);
    expect(isAgentChannelPostingEnabledForWorkspace(caps, "owner-ws")).toBe(true);
    expect(isAgentChannelPostingEnabledForWorkspace(caps, "someone-else")).toBe(false);
  });

  it("turns the layer on from deployment env (RELOAD_AGENT_CHANNEL_POSTING_*) for the named owner only", () => {
    const cfg = loadConfig("owner-ws", {
      env: {
        RELOAD_AGENT_CHANNEL_POSTING_ENABLED: "true",
        RELOAD_AGENT_CHANNEL_POSTING_OWNER_WORKSPACE_ID: "owner-ws",
      },
      readFile: () => undefined,
    });
    const caps = resolveAgentChannelPostingCaps(cfg.agentChannelPosting);
    expect(caps.enabled).toBe(true);
    expect(isAgentChannelPostingEnabledForWorkspace(caps, "owner-ws")).toBe(true);
    expect(isAgentChannelPostingEnabledForWorkspace(caps, "another-ws")).toBe(false);
  });

  it("falls back to the shared RELOAD_MARKETING_OWNER_WORKSPACE_ID marker", () => {
    const cfg = loadConfig("owner-ws", {
      env: {
        RELOAD_AGENT_CHANNEL_POSTING_ENABLED: "true",
        RELOAD_MARKETING_OWNER_WORKSPACE_ID: "owner-ws",
      },
      readFile: () => undefined,
    });
    const caps = resolveAgentChannelPostingCaps(cfg.agentChannelPosting);
    expect(isAgentChannelPostingEnabledForWorkspace(caps, "owner-ws")).toBe(true);
    expect(isAgentChannelPostingEnabledForWorkspace(caps, "other")).toBe(false);
  });

  it("enabling WITHOUT naming an owner posts for nobody (the safest default)", () => {
    const cfg = loadConfig("ws-x", {
      env: { RELOAD_AGENT_CHANNEL_POSTING_ENABLED: "true" },
      readFile: () => undefined,
    });
    expect(
      isAgentChannelPostingEnabledForWorkspace(
        resolveAgentChannelPostingCaps(cfg.agentChannelPosting),
        "ws-x",
      ),
    ).toBe(false);
  });

  it("posts for ALL tenants only when ownerWorkspaceOnly is explicitly false", () => {
    const caps = resolveAgentChannelPostingCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isAgentChannelPostingEnabledForWorkspace(caps, "any-ws")).toBe(true);
    // still off when the master flag is off
    expect(
      isAgentChannelPostingEnabledForWorkspace({ ...caps, enabled: false }, "any-ws"),
    ).toBe(false);
  });
});
