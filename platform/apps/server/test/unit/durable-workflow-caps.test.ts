import { describe, it, expect } from "vitest";
import {
  resolveDurableWorkflowCaps,
  isDurableWorkflowEnabledForWorkspace,
  backoffPolicyFromCaps,
  DURABLE_WORKFLOW_DEFAULTS,
} from "../../src/durable-workflow/caps.js";

describe("durable-workflow/caps — resolveDurableWorkflowCaps", () => {
  it("defaults OFF and owner-workspace-first when no config is supplied", () => {
    const caps = resolveDurableWorkflowCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.ownerWorkspaceOnly).toBe(true);
    expect(caps.ownerWorkspaceId).toBeUndefined();
  });

  it("an empty config block keeps the defaults (a deployment that sets nothing is unchanged)", () => {
    expect(resolveDurableWorkflowCaps({})).toEqual(DURABLE_WORKFLOW_DEFAULTS);
  });

  it("applies supplied overrides", () => {
    const caps = resolveDurableWorkflowCaps({
      enabled: true,
      ownerWorkspaceOnly: false,
      ownerWorkspaceId: "ws-owner",
      maxAttempts: 10,
      backoffBaseMs: 1000,
      backoffCapMs: 5000,
      defaultTimeoutMs: 60_000,
    });
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceOnly).toBe(false);
    expect(caps.maxAttempts).toBe(10);
    expect(caps.backoffBaseMs).toBe(1000);
    expect(caps.backoffCapMs).toBe(5000);
    expect(caps.defaultTimeoutMs).toBe(60_000);
  });

  it("derives the runner backoff policy from caps (factor is fixed at 2)", () => {
    const policy = backoffPolicyFromCaps(
      resolveDurableWorkflowCaps({ maxAttempts: 7, backoffBaseMs: 2000, backoffCapMs: 9000 }),
    );
    expect(policy).toEqual({ baseMs: 2000, factor: 2, capMs: 9000, maxAttempts: 7 });
  });
});

describe("durable-workflow/caps — isDurableWorkflowEnabledForWorkspace", () => {
  it("is OFF when the master flag is off", () => {
    expect(
      isDurableWorkflowEnabledForWorkspace(resolveDurableWorkflowCaps({ enabled: false }), "ws-1"),
    ).toBe(false);
  });

  it("enabled without an owner workspace runs for nobody (safest default)", () => {
    expect(
      isDurableWorkflowEnabledForWorkspace(resolveDurableWorkflowCaps({ enabled: true }), "ws-1"),
    ).toBe(false);
  });

  it("enabled + ownerWorkspaceOnly routes only the named owner workspace", () => {
    const caps = resolveDurableWorkflowCaps({ enabled: true, ownerWorkspaceId: "ws-owner" });
    expect(isDurableWorkflowEnabledForWorkspace(caps, "ws-owner")).toBe(true);
    expect(isDurableWorkflowEnabledForWorkspace(caps, "ws-other")).toBe(false);
  });

  it("ownerWorkspaceOnly=false routes all tenants once enabled", () => {
    const caps = resolveDurableWorkflowCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isDurableWorkflowEnabledForWorkspace(caps, "ws-anything")).toBe(true);
  });
});
