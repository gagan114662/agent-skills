import { describe, it, expect } from "vitest";
import { decideProvision, decideRelease, releaseStatusFor } from "../../src/venture-deploy/decide.js";
import { resolveVentureDeployCaps, type VentureDeployCaps } from "../../src/venture-deploy/caps.js";

/** Build caps from the config layer so the tests pin the real default-resolution path. */
function caps(over: Partial<VentureDeployCaps> = {}): VentureDeployCaps {
  return { ...resolveVentureDeployCaps({ enabled: true }), ...over };
}

describe("decideProvision (#195 AC1: per-venture provisioning)", () => {
  it("provisions for the owner workspace when enabled and under cap", () => {
    const d = decideProvision({
      caps: caps(),
      isOwnerWorkspace: true,
      alreadyProvisioned: false,
      estimatedSetupCents: 0,
    });
    expect(d).toEqual({ action: "provision", reversibility: "reversible", reason: "provision" });
  });

  it("is OFF by default — a workspace with no config never provisions", () => {
    const d = decideProvision({
      caps: resolveVentureDeployCaps(undefined),
      isOwnerWorkspace: true,
      alreadyProvisioned: false,
      estimatedSetupCents: 0,
    });
    expect(d.action).toBe("skip_disabled");
  });

  it("ownerWorkspaceOnly bars a non-owner workspace", () => {
    const d = decideProvision({
      caps: caps(),
      isOwnerWorkspace: false,
      alreadyProvisioned: false,
      estimatedSetupCents: 0,
    });
    expect(d.action).toBe("skip_not_owner");
  });

  it("is idempotent — an already-provisioned venture is a free no-op, even over cap", () => {
    const d = decideProvision({
      caps: caps(),
      isOwnerWorkspace: true,
      alreadyProvisioned: true,
      estimatedSetupCents: 999_999,
    });
    expect(d.action).toBe("skip_exists");
  });

  it("refuses provisioning that would exceed the hard per-venture infra cap", () => {
    const d = decideProvision({
      caps: caps({ infraSetupCapCents: 5_000 }),
      isOwnerWorkspace: true,
      alreadyProvisioned: false,
      estimatedSetupCents: 5_001,
    });
    expect(d.action).toBe("skip_over_cap");
  });

  it("allows spend exactly at the cap (boundary)", () => {
    const d = decideProvision({
      caps: caps({ infraSetupCapCents: 5_000 }),
      isOwnerWorkspace: true,
      alreadyProvisioned: false,
      estimatedSetupCents: 5_000,
    });
    expect(d.action).toBe("provision");
  });

  it("allows a non-owner workspace once ownerWorkspaceOnly is lifted", () => {
    const d = decideProvision({
      caps: caps({ ownerWorkspaceOnly: false }),
      isOwnerWorkspace: false,
      alreadyProvisioned: false,
      estimatedSetupCents: 0,
    });
    expect(d.action).toBe("provision");
  });
});

describe("decideRelease (#195 AC2/AC3: production-grounded release gate)", () => {
  const green = {
    caps: caps(),
    deployOk: true,
    smokeRan: true,
    smokeCriticalCount: 0,
    hasRollbackTarget: true,
  };

  it("promotes only on a real green smoke — gated by default", () => {
    const d = decideRelease(green);
    expect(d.action).toBe("promote");
    expect(d.reversibility).toBe("cheap");
    expect(d.requiresApproval).toBe(true); // requireApprovalForProdPromote default ON
    expect(d.fileIncident).toBe(false);
    expect(d.reason).toBe("smoke_green_promote_gated");
  });

  it("promotes autonomously once the owner pre-commits the cutover (#200 §4)", () => {
    const d = decideRelease({ ...green, caps: caps({ preCommitProdPromote: true }) });
    expect(d.action).toBe("promote");
    expect(d.requiresApproval).toBe(false);
    expect(d.reason).toBe("smoke_green_promote");
  });

  it("NEVER promotes a release whose smoke did not run (#200 §3)", () => {
    const d = decideRelease({ ...green, smokeRan: false });
    expect(d.action).toBe("escalate");
    expect(d.reason).toBe("smoke_did_not_run");
    expect(d.fileIncident).toBe(true);
  });

  it("a broken image (critical smoke finding) auto-rolls back — no human (#195 AC3)", () => {
    const d = decideRelease({ ...green, smokeCriticalCount: 2 });
    expect(d.action).toBe("rollback");
    expect(d.reversibility).toBe("cheap");
    expect(d.requiresApproval).toBe(false); // autoRollbackOnSmokeFail IS the pre-commitment
    expect(d.fileIncident).toBe(true);
    expect(d.reason).toBe("smoke_failed");
  });

  it("a failed DEPLOY auto-rolls back when a target exists", () => {
    const d = decideRelease({ ...green, deployOk: false });
    expect(d.action).toBe("rollback");
    expect(d.reason).toBe("deploy_failed");
    expect(d.fileIncident).toBe(true);
  });

  it("escalates a broken image when there is no rollback target (first release)", () => {
    const d = decideRelease({ ...green, smokeCriticalCount: 1, hasRollbackTarget: false });
    expect(d.action).toBe("escalate");
    expect(d.requiresApproval).toBe(true);
    expect(d.reason).toBe("smoke_failed_no_target");
    expect(d.fileIncident).toBe(true);
  });

  it("escalates (does not roll back) a broken image when auto-rollback is disabled", () => {
    const d = decideRelease({ ...green, smokeCriticalCount: 1, caps: caps({ autoRollbackOnSmokeFail: false }) });
    expect(d.action).toBe("escalate");
    expect(d.reason).toBe("smoke_failed_no_autorollback");
  });

  it("can suppress incident filing via config", () => {
    const d = decideRelease({ ...green, smokeCriticalCount: 1, caps: caps({ fileIncidentOnFailure: false }) });
    expect(d.fileIncident).toBe(false);
  });
});

describe("releaseStatusFor", () => {
  it("maps actions/reasons to the durable receipt status", () => {
    expect(releaseStatusFor("promote", "smoke_green_promote")).toBe("promoted");
    expect(releaseStatusFor("rollback", "smoke_failed")).toBe("rolled_back");
    expect(releaseStatusFor("escalate", "deploy_failed_no_target")).toBe("deploy_failed");
    expect(releaseStatusFor("escalate", "smoke_did_not_run")).toBe("smoke_failed");
    expect(releaseStatusFor("escalate", "smoke_failed_no_target")).toBe("smoke_failed");
    expect(releaseStatusFor("escalate", "anything_else")).toBe("escalated");
  });
});
