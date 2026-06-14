import { loadConfig } from "../config/loader.js";
import { windowKey } from "../scale/usage.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { getUsage, recordSessionCompute } from "../db/repositories/tenant-usage.js";
import { resolveServiceSecrets } from "../db/repositories/external-credentials.js";
import { createRequest } from "../db/repositories/approvals.js";
import { dbDeployTargetStore, dbReleaseStore } from "../db/repositories/venture-deploy.js";
import { DryRunDeployProvider } from "../deploy/dry-run-provider.js";
import { checksForSuite } from "../selfqa/catalog.js";
import { httpSmokeDriver } from "../selfqa/driver.js";
import { classifyResults } from "../selfqa/classify.js";
import {
  filePostmortem,
  flywheelPostmortemReporter,
  type OpsPostmortem,
} from "../self-healing/reporter.js";
import type { FailureEvent } from "../flywheel/types.js";
import { resolveVentureDeployCaps } from "./caps.js";
import { VentureDeployProvisioner, type ProvisionBudget } from "./provisioner.js";
import {
  VentureReleasePipeline,
  type PriorProdDeploy,
  type ReleaseDeployer,
  type ReleaseDeployOutcome,
  type ReleaseIncidentFiler,
  type SmokeRunner,
} from "./release.js";

/**
 * Production wiring for Venture Deploys (#195, ADR-0195). The deploy-target store, the release-receipt
 * store, the #71 budget ceiling (same tenant-usage accounting as the factory), the #192 vault secret
 * resolver, and the #193 incident reporters are real. The release `deployer` is the no-spend dry-run
 * backend by default (a runner image points it at a venture-scoped #73 DeployManager); the smoke runner
 * is the dependency-free #171 http probe. Default-OFF: with no `ventureDeploys` config the provisioner's
 * pure gate refuses, and the build-loop release verifier is simply not attached.
 */

/** The #71 dollar ceiling — the SAME tenant-usage accounting the factory charges scans against. */
const budget: ProvisionBudget = {
  charge: async (workspaceId, cents, _reason) => {
    if (cents <= 0) return true;
    const now = new Date();
    const budgetCents = resolveScaleCaps(loadConfig(workspaceId).scale).budgetCents;
    const spent = (await getUsage(workspaceId, windowKey(now))).estimatedCostCents;
    if (budgetCents > 0 && spent + cents > budgetCents) return false;
    await recordSessionCompute(workspaceId, windowKey(now), 0, cents);
    return true;
  },
};

export interface DefaultProvisionerDeps {
  /** The owner workspace resolver for `ownerWorkspaceOnly` (app.ts supplies it; default ⇒ treat as owner). */
  ownerWorkspaceId?: (workspaceId: string) => Promise<string | null>;
  now?: () => Date;
}

export function createDefaultVentureDeployProvisioner(
  deps: DefaultProvisionerDeps = {},
): VentureDeployProvisioner {
  return new VentureDeployProvisioner({
    caps: (workspaceId) => resolveVentureDeployCaps(loadConfig(workspaceId).ventureDeploys),
    isOwnerWorkspace: async (workspaceId) => {
      if (!deps.ownerWorkspaceId) return true; // no resolver ⇒ only the enabled/cap gates apply
      const owner = await deps.ownerWorkspaceId(workspaceId);
      return owner === null || owner === workspaceId;
    },
    targets: dbDeployTargetStore,
    budget,
    estimateSetupCents: Number(process.env.VENTURE_DEPLOY_SETUP_CENTS ?? "0") || 0,
    now: deps.now,
  });
}

/**
 * The dependency-free #171 http smoke runner pointed at a deployed URL — the production-grounded release
 * gate (#200 §3). A probe error is a FAILED critical check (never a throw, never a silent pass), so
 * `ran` is always true once we reached the live URL.
 */
export function createHttpSmokeRunner(fetchImpl: typeof fetch = fetch): SmokeRunner {
  return {
    run: async ({ url }) => {
      const checks = checksForSuite("smoke");
      const driver = httpSmokeDriver(fetchImpl);
      const results = [];
      for (const check of checks) results.push(await driver.run(check, { target: url }));
      const findings = classifyResults(results, checks);
      const criticalCount = findings.filter((f) => f.severity === "critical").length;
      return {
        ran: true,
        criticalCount,
        detail: `${findings.length} smoke finding(s), ${criticalCount} critical against ${url}`,
      };
    },
  };
}

/**
 * The no-spend default release deployer: it exercises the full deploy → rollback surface via the #73
 * `DryRunDeployProvider` and tracks the last good prod deployment in-process. A runner image swaps this
 * for a deployer backed by a venture-scoped #73 `DeployManager` (real Fly/Vercel pushes) — the pipeline
 * contract is identical.
 */
export function createDryRunReleaseDeployer(): ReleaseDeployer {
  const provider = new DryRunDeployProvider();
  const prod = new Map<string, PriorProdDeploy>();
  const key = (ws: string, v: string): string => `${ws}|${v}`;
  return {
    async deployPreview(input): Promise<ReleaseDeployOutcome> {
      const out = await provider.deploy({
        deploymentId: `${input.ventureId}-${input.releaseRef}`,
        workspaceId: input.workspaceId,
        sessionId: input.ventureId,
        slug: `${input.targetId}-preview`,
        stack: { framework: "node" },
        env: {},
        secrets: input.secrets,
        onLog: () => {},
      });
      return {
        ok: out.status === "ready",
        url: out.url ?? null,
        providerDeploymentId: out.providerDeploymentId ?? null,
        detail: out.status === "ready" ? "deployed to preview" : out.error ?? "deploy error",
      };
    },
    async latestProd({ workspaceId, ventureId }) {
      return prod.get(key(workspaceId, ventureId)) ?? null;
    },
    async promote({ workspaceId, ventureId, prodUrl, providerDeploymentId }) {
      prod.set(key(workspaceId, ventureId), {
        providerDeploymentId: providerDeploymentId ?? `dpl_${ventureId}`,
        url: prodUrl,
      });
    },
    async rollback({ prior }): Promise<ReleaseDeployOutcome> {
      const out = await provider.rollback({
        providerDeploymentId: prior.providerDeploymentId,
        url: prior.url,
      });
      return {
        ok: out.status === "ready",
        url: out.url ?? null,
        providerDeploymentId: out.providerDeploymentId ?? null,
        detail: "rolled back to last good prod",
      };
    },
  };
}

/** Files a release incident through the #193 flywheel reporter (records an `ops_incident`, feeds #172). */
export function createReleaseIncidentFiler(
  flywheelRecord: (event: FailureEvent) => Promise<unknown>,
): ReleaseIncidentFiler {
  const reporters = [flywheelPostmortemReporter({ record: flywheelRecord })];
  return {
    file: async (pm: OpsPostmortem) => {
      await filePostmortem(pm, reporters);
    },
  };
}

export interface DefaultReleasePipelineDeps {
  /** A real venture-scoped deployer (#73-backed); default ⇒ the no-spend dry-run deployer. */
  deployer?: ReleaseDeployer;
  /** The #193 flywheel recorder (app.ts owns the FlywheelEngine); when omitted, incidents are not filed. */
  flywheelRecord?: (event: FailureEvent) => Promise<unknown>;
  /** Override the smoke runner (tests inject a fake fetch); default ⇒ the http smoke runner. */
  smoke?: SmokeRunner;
  /** Resolve which AGENT member a parked release decision is attributed to (the #13 requester FK). */
  now?: () => Date;
}

export function createDefaultVentureReleasePipeline(
  deps: DefaultReleasePipelineDeps = {},
): VentureReleasePipeline {
  return new VentureReleasePipeline({
    caps: (workspaceId) => resolveVentureDeployCaps(loadConfig(workspaceId).ventureDeploys),
    targets: dbDeployTargetStore,
    releases: dbReleaseStore,
    deployer: deps.deployer ?? createDryRunReleaseDeployer(),
    smoke: deps.smoke ?? createHttpSmokeRunner(),
    approvals: {
      submit: async (input) => {
        const req = await createRequest({
          workspaceId: input.workspaceId,
          requesterMemberId: input.requesterMemberId,
          actionType: "venture.deploy", // sensitive-by-default → a human gate for the prod cutover
          payload: input.payload,
          amount: null,
          summary: input.summary,
          status: "pending",
          expiresAt: null,
          events: [{ type: "requested", detail: { source: "venture-deploy", ...input.payload } }],
        });
        return { id: req.id };
      },
    },
    incident: deps.flywheelRecord ? createReleaseIncidentFiler(deps.flywheelRecord) : undefined,
    resolveSecrets: (workspaceId, serviceKey) => resolveServiceSecrets(workspaceId, serviceKey),
    now: deps.now,
  });
}
