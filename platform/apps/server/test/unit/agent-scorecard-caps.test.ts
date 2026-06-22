/**
 * Unit tests for the per-agent scorecard caps (#593): default-OFF, env parsing, owner-workspace-first scoping.
 */

import { describe, it, expect } from "vitest";
import {
  resolveScorecardCaps,
  isScorecardEnabledForWorkspace,
  SCORECARD_DEFAULTS,
  type ScorecardCaps,
} from "../../src/agent-scorecard/caps.js";
import { DEFAULT_PIPELINE_WEIGHT } from "../../src/agent-scorecard/score.js";

describe("defaults", () => {
  it("is OFF and owner-workspace-first by default", () => {
    expect(SCORECARD_DEFAULTS.enabled).toBe(false);
    expect(SCORECARD_DEFAULTS.ownerWorkspaceOnly).toBe(true);
    expect(SCORECARD_DEFAULTS.ownerWorkspaceId).toBeNull();
    expect(SCORECARD_DEFAULTS.pipelineWeight).toBe(DEFAULT_PIPELINE_WEIGHT);
  });

  it("resolves to the defaults from an empty environment", () => {
    expect(resolveScorecardCaps({})).toEqual(SCORECARD_DEFAULTS);
  });
});

describe("env parsing", () => {
  it("enables only on explicit truthy tokens", () => {
    expect(resolveScorecardCaps({ AGENT_SCORECARD_ENABLED: "true" }).enabled).toBe(true);
    expect(resolveScorecardCaps({ AGENT_SCORECARD_ENABLED: "1" }).enabled).toBe(true);
    expect(resolveScorecardCaps({ AGENT_SCORECARD_ENABLED: "on" }).enabled).toBe(true);
    expect(resolveScorecardCaps({ AGENT_SCORECARD_ENABLED: "false" }).enabled).toBe(false);
    expect(resolveScorecardCaps({ AGENT_SCORECARD_ENABLED: "garbage" }).enabled).toBe(false);
  });

  it("reads the owner workspace id and the broaden flag", () => {
    const caps = resolveScorecardCaps({
      AGENT_SCORECARD_ENABLED: "true",
      AGENT_SCORECARD_OWNER_WORKSPACE_ONLY: "false",
      AGENT_SCORECARD_OWNER_WORKSPACE_ID: "  ws-owner  ",
    });
    expect(caps.ownerWorkspaceOnly).toBe(false);
    expect(caps.ownerWorkspaceId).toBe("ws-owner");
  });

  it("parses the pipeline weight, falling back on out-of-range / invalid", () => {
    expect(resolveScorecardCaps({ AGENT_SCORECARD_PIPELINE_WEIGHT: "0.5" }).pipelineWeight).toBe(0.5);
    expect(resolveScorecardCaps({ AGENT_SCORECARD_PIPELINE_WEIGHT: "0" }).pipelineWeight).toBe(0);
    expect(resolveScorecardCaps({ AGENT_SCORECARD_PIPELINE_WEIGHT: "9" }).pipelineWeight).toBe(
      DEFAULT_PIPELINE_WEIGHT,
    );
    expect(resolveScorecardCaps({ AGENT_SCORECARD_PIPELINE_WEIGHT: "abc" }).pipelineWeight).toBe(
      DEFAULT_PIPELINE_WEIGHT,
    );
  });
});

describe("enablement (fail-closed, owner-first)", () => {
  const WID = "ws-1";
  const OTHER = "ws-2";

  it("is never enabled when the master flag is off", () => {
    const caps: ScorecardCaps = { ...SCORECARD_DEFAULTS, enabled: false, ownerWorkspaceOnly: false };
    expect(isScorecardEnabledForWorkspace(caps, WID)).toBe(false);
  });

  it("owner-first lets in only the configured owner workspace", () => {
    const caps: ScorecardCaps = {
      enabled: true,
      ownerWorkspaceOnly: true,
      ownerWorkspaceId: WID,
      pipelineWeight: 0.3,
    };
    expect(isScorecardEnabledForWorkspace(caps, WID)).toBe(true);
    expect(isScorecardEnabledForWorkspace(caps, OTHER)).toBe(false);
  });

  it("owner-first with no owner id lets nobody in (safe default, never everybody)", () => {
    const caps: ScorecardCaps = {
      enabled: true,
      ownerWorkspaceOnly: true,
      ownerWorkspaceId: null,
      pipelineWeight: 0.3,
    };
    expect(isScorecardEnabledForWorkspace(caps, WID)).toBe(false);
  });

  it("broadened (ownerWorkspaceOnly false) lets everybody in once enabled", () => {
    const caps: ScorecardCaps = {
      enabled: true,
      ownerWorkspaceOnly: false,
      ownerWorkspaceId: null,
      pipelineWeight: 0.3,
    };
    expect(isScorecardEnabledForWorkspace(caps, WID)).toBe(true);
    expect(isScorecardEnabledForWorkspace(caps, OTHER)).toBe(true);
  });
});
