import { describe, it, expect } from "vitest";
import {
  VentureReleasePipeline,
  releasePipelineAsPostMergeVerifier,
  NoDeployTargetError,
  type ReleaseDeployer,
  type ReleaseDeployOutcome,
  type PriorProdDeploy,
  type SmokeRunner,
  type SmokeRunResult,
} from "../../src/venture-deploy/release.js";
import { resolveVentureDeployCaps, type VentureDeployCaps } from "../../src/venture-deploy/caps.js";
import type { DeployTarget, ReleaseReceipt } from "../../src/venture-deploy/types.js";
import type {
  CreateReleaseReceiptInput,
  DeployTargetStore,
  ReleaseStore,
} from "../../src/venture-deploy/store.js";
import type { OpsPostmortem } from "../../src/self-healing/reporter.js";

function caps(over: Partial<VentureDeployCaps> = {}): VentureDeployCaps {
  return { ...resolveVentureDeployCaps({ enabled: true }), ...over };
}

const TARGET: DeployTarget = {
  id: "t1",
  workspaceId: "ws1",
  ventureId: "v1",
  provider: "dryrun",
  projectId: "proj_acme",
  previewUrl: "https://acme-preview.dryrun.reload.app",
  prodUrl: "https://acme.dryrun.reload.app",
  status: "provisioned",
  secretServiceKey: "venture-deploy:v1",
  createdAt: new Date(0),
};

function targetStore(target: DeployTarget | null = TARGET): DeployTargetStore {
  return {
    async getByVenture() {
      return target ?? undefined;
    },
    async create() {
      throw new Error("not used");
    },
  };
}

function releaseStore(): ReleaseStore & { rows: ReleaseReceipt[] } {
  const rows: ReleaseReceipt[] = [];
  let seq = 0;
  return {
    rows,
    async create(input: CreateReleaseReceiptInput) {
      const row: ReleaseReceipt = {
        id: `r${++seq}`,
        createdAt: new Date(0),
        approvalRequestId: input.approvalRequestId ?? null,
        url: input.url ?? null,
        ...input,
      } as ReleaseReceipt;
      rows.push(row);
      return row;
    },
    async listRecentForWorkspace() {
      return [...rows].reverse();
    },
  };
}

type FakeDeployer = ReleaseDeployer & {
  promoted: number;
  rolledBack: number;
  deployedSecrets: Record<string, string>[];
};

function fakeDeployer(over: {
  deployOk?: boolean;
  deployUrl?: string | null;
  prior?: PriorProdDeploy | null;
} = {}): FakeDeployer {
  const d: FakeDeployer = {
    promoted: 0,
    rolledBack: 0,
    deployedSecrets: [],
    async deployPreview(input): Promise<ReleaseDeployOutcome> {
      d.deployedSecrets.push(input.secrets);
      const ok = over.deployOk ?? true;
      return {
        ok,
        url: ok ? over.deployUrl ?? input.previewUrl : null,
        providerDeploymentId: ok ? "dpl_1" : null,
        detail: ok ? "deployed" : "build failed",
      };
    },
    async latestProd() {
      return over.prior ?? null;
    },
    async promote() {
      d.promoted += 1;
    },
    async rollback(): Promise<ReleaseDeployOutcome> {
      d.rolledBack += 1;
      return { ok: true, url: (over.prior ?? { url: "x" }).url, providerDeploymentId: "dpl_0", detail: "rolled back" };
    },
  };
  return d;
}

function fakeSmoke(result: SmokeRunResult): SmokeRunner {
  return { async run() { return result; } };
}

const PRIOR: PriorProdDeploy = { providerDeploymentId: "dpl_0", url: "https://acme.dryrun.reload.app" };

function build(over: {
  caps?: VentureDeployCaps;
  target?: DeployTarget | null;
  deployer?: ReturnType<typeof fakeDeployer>;
  smoke?: SmokeRunner;
  withApprovals?: boolean;
  withIncident?: boolean;
  resolveSecrets?: (ws: string, key: string) => Promise<Record<string, string>>;
} = {}) {
  const releases = releaseStore();
  const incidents: OpsPostmortem[] = [];
  const approvals = { submitted: [] as string[], async submit() { approvals.submitted.push("x"); return { id: "appr1" }; } };
  const pipeline = new VentureReleasePipeline({
    caps: () => over.caps ?? caps(),
    targets: targetStore(over.target === undefined ? TARGET : over.target),
    releases,
    deployer: over.deployer ?? fakeDeployer(),
    smoke: over.smoke ?? fakeSmoke({ ran: true, criticalCount: 0, detail: "ok" }),
    approvals: over.withApprovals === false ? undefined : approvals,
    incident: over.withIncident === false ? undefined : { async file(pm) { incidents.push(pm); } },
    resolveSecrets: over.resolveSecrets,
    now: () => new Date(0),
  });
  return { pipeline, releases, incidents, approvals };
}

const releaseInput = { workspaceId: "ws1", ventureId: "v1", releaseRef: "abc123", requesterMemberId: "m1" };

describe("VentureReleasePipeline (#195 AC2/AC3)", () => {
  it("a green smoke parks the prod cutover for owner approval by default", async () => {
    const deployer = fakeDeployer({ prior: PRIOR });
    const { pipeline, releases, approvals } = build({ deployer });
    const r = await pipeline.release(releaseInput);
    expect(r.action).toBe("promote");
    expect(r.requiresApproval).toBe(true);
    expect(r.status).toBe("escalated"); // parked, not promoted
    expect(r.approvalRequestId).toBe("appr1");
    expect(deployer.promoted).toBe(0);
    expect(approvals.submitted).toHaveLength(1);
    expect(releases.rows).toHaveLength(1);
  });

  it("promotes autonomously once the owner pre-commits the cutover", async () => {
    const deployer = fakeDeployer({ prior: PRIOR });
    const { pipeline, releases } = build({ caps: caps({ preCommitProdPromote: true }), deployer });
    const r = await pipeline.release(releaseInput);
    expect(r.action).toBe("promote");
    expect(r.requiresApproval).toBe(false);
    expect(r.status).toBe("promoted");
    expect(r.url).toBe(TARGET.prodUrl);
    expect(deployer.promoted).toBe(1);
    expect(releases.rows[0]!.incidentFiled).toBe(false);
  });

  it("auto-rolls back a broken image (critical smoke) and files an incident — no human", async () => {
    const deployer = fakeDeployer({ prior: PRIOR });
    const { pipeline, incidents, releases } = build({
      deployer,
      smoke: fakeSmoke({ ran: true, criticalCount: 3, detail: "checkout 500s" }),
    });
    const r = await pipeline.release(releaseInput);
    expect(r.action).toBe("rollback");
    expect(r.status).toBe("rolled_back");
    expect(r.requiresApproval).toBe(false);
    expect(r.incidentFiled).toBe(true);
    expect(deployer.rolledBack).toBe(1);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.signature).toBe("ws1|venture-deploy:v1|uptime");
    expect(incidents[0]!.action).toBe("rollback");
    expect(releases.rows[0]!.smokeCriticalCount).toBe(3);
  });

  it("rolls back a failed DEPLOY when a prior prod exists", async () => {
    const deployer = fakeDeployer({ deployOk: false, prior: PRIOR });
    const { pipeline, incidents } = build({ deployer });
    const r = await pipeline.release(releaseInput);
    expect(r.action).toBe("rollback");
    expect(deployer.rolledBack).toBe(1);
    expect(r.detail).toContain("deploy_failed");
    expect(incidents).toHaveLength(1);
  });

  it("escalates a broken first release (no rollback target) and files an incident", async () => {
    const { pipeline, approvals, incidents, releases } = build({
      deployer: fakeDeployer({ prior: null }),
      smoke: fakeSmoke({ ran: true, criticalCount: 1, detail: "blank page" }),
    });
    const r = await pipeline.release(releaseInput);
    expect(r.action).toBe("escalate");
    expect(r.status).toBe("smoke_failed");
    expect(r.approvalRequestId).toBe("appr1");
    expect(approvals.submitted).toHaveLength(1);
    expect(incidents).toHaveLength(1);
    expect(releases.rows[0]!.smokeCriticalCount).toBe(1);
  });

  it("never promotes a release whose smoke could not run (deploy ok but smoke seam reports !ran)", async () => {
    const { pipeline } = build({
      deployer: fakeDeployer({ prior: PRIOR }),
      smoke: fakeSmoke({ ran: false, criticalCount: -1, detail: "smoke crashed" }),
    });
    const r = await pipeline.release(releaseInput);
    expect(r.action).toBe("escalate");
    expect(r.smokeCriticalCount).toBe(-1);
  });

  it("does not file an incident when fileIncidentOnFailure is off", async () => {
    const { pipeline, incidents } = build({
      caps: caps({ fileIncidentOnFailure: false }),
      deployer: fakeDeployer({ prior: PRIOR }),
      smoke: fakeSmoke({ ran: true, criticalCount: 2, detail: "x" }),
    });
    const r = await pipeline.release(releaseInput);
    expect(r.incidentFiled).toBe(false);
    expect(incidents).toHaveLength(0);
  });

  it("injects the venture's vault secrets into the deploy (AC5)", async () => {
    const deployer = fakeDeployer({ prior: PRIOR });
    const { pipeline } = build({
      deployer,
      resolveSecrets: async (_ws, key) => ({ KEY_FOR: key }),
    });
    await pipeline.release(releaseInput);
    expect(deployer.deployedSecrets[0]).toEqual({ KEY_FOR: "venture-deploy:v1" });
  });

  it("throws when the venture has no provisioned target", async () => {
    const { pipeline } = build({ target: null });
    await expect(pipeline.release(releaseInput)).rejects.toThrow(NoDeployTargetError);
  });
});

describe("releasePipelineAsPostMergeVerifier", () => {
  it("is a no-op for a non-venture run (byte-for-byte safe for agent-skills self-shipping)", async () => {
    const { pipeline, releases } = build();
    const verifier = releasePipelineAsPostMergeVerifier(pipeline, () => null);
    const out = await verifier.verify({ workspaceId: "ws1", run: { workspaceId: "ws1", issueRef: "x#1" } });
    expect(out.regressions).toBe(0);
    expect(releases.rows).toHaveLength(0); // pipeline never ran
  });

  it("runs the release pipeline for a venture run; a promoted release is 0 regressions", async () => {
    const { pipeline } = build({ caps: caps({ preCommitProdPromote: true }), deployer: fakeDeployer({ prior: PRIOR }) });
    const verifier = releasePipelineAsPostMergeVerifier(pipeline, () => ({
      ventureId: "v1",
      releaseRef: "abc123",
      requesterMemberId: "m1",
    }));
    const out = await verifier.verify({ workspaceId: "ws1", run: { workspaceId: "ws1", issueRef: "acme#9" } });
    expect(out.regressions).toBe(0);
  });

  it("surfaces ≥1 regression for a rolled-back venture release so the loop escalates", async () => {
    const { pipeline } = build({
      deployer: fakeDeployer({ prior: PRIOR }),
      smoke: fakeSmoke({ ran: true, criticalCount: 4, detail: "x" }),
    });
    const verifier = releasePipelineAsPostMergeVerifier(pipeline, () => ({
      ventureId: "v1",
      releaseRef: "abc123",
      requesterMemberId: "m1",
    }));
    const out = await verifier.verify({ workspaceId: "ws1", run: { workspaceId: "ws1", issueRef: "acme#9" } });
    expect(out.regressions).toBe(4);
  });
});
