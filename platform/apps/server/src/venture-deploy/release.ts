import type { VentureDeployCaps } from "./caps.js";
import { decideRelease, releaseStatusFor } from "./decide.js";
import type { DeployTargetStore, ReleaseStore } from "./store.js";
import type { ReleaseReceipt } from "./types.js";
import type { OpsPostmortem } from "../self-healing/reporter.js";

/**
 * The venture release pipeline (#195 AC2/AC3) — the generalization of the #172 ship-loop's deploy step
 * onto a venture repo: **deploy the merged build to the venture's preview target → run the #171 smoke
 * against the live preview URL → decide → promote / auto-roll-back / escalate → write an immutable
 * receipt** and file a #193 self-healing incident on failure.
 *
 * The only path to a customer-facing prod cutover is a real green smoke (#200 §3 — production-grounded
 * verification is the only final tier; a release that never touched reality is never promoted). A broken
 * image is rolled back without a human (AC3), the pre-committed safety action. Every seam is injected so
 * the whole pipeline is unit-tested with fakes; the default wiring (default.ts) backs `deployer` with the
 * #73 DeployManager and `smoke` with the #171 http smoke driver.
 */

export interface ReleaseDeployOutcome {
  ok: boolean;
  url: string | null;
  providerDeploymentId: string | null;
  detail: string;
}

export interface ReleasePromoteHealth {
  ok: boolean;
  detail: string;
}

/** A prior good prod deployment to roll back to. */
export interface PriorProdDeploy {
  providerDeploymentId: string;
  url: string;
}

/**
 * Wraps the #73 deploy machinery for a venture: deploy a build to preview, find the last good prod
 * deploy, promote a good preview to prod, roll prod back. The default impl points the #73 DeployManager
 * at the venture's target; tests inject a fake.
 */
export interface ReleaseDeployer {
  deployPreview(input: {
    workspaceId: string;
    ventureId: string;
    targetId: string;
    previewUrl: string;
    releaseRef: string;
    secrets: Record<string, string>;
  }): Promise<ReleaseDeployOutcome>;
  /** The last good PROD deployment to roll back to, or null (a first release has none). */
  latestProd(input: { workspaceId: string; ventureId: string }): Promise<PriorProdDeploy | null>;
  /** Promote a good preview deployment to prod — the customer-facing cutover. */
  promote(input: {
    workspaceId: string;
    ventureId: string;
    prodUrl: string;
    providerDeploymentId: string | null;
  }): Promise<void>;
  /** Verify the customer-facing prod URL after promote; omitted only by legacy/dry-run fakes. */
  healthCheck?(url: string): Promise<ReleasePromoteHealth>;
  /** Roll prod back to a prior good deployment — the autonomous safety action (#195 AC3). */
  rollback(input: {
    workspaceId: string;
    ventureId: string;
    prior: PriorProdDeploy;
  }): Promise<ReleaseDeployOutcome>;
}

export interface SmokeRunResult {
  /** Did the smoke actually run against the live URL? `false` is NEVER treated as a pass (#200 §3). */
  ran: boolean;
  /** Number of critical findings (meaningful only when `ran`). */
  criticalCount: number;
  detail: string;
}

/** Runs the #171 smoke suite against a deployed URL. Default impl = the dependency-free http smoke driver. */
export interface SmokeRunner {
  run(input: { url: string }): Promise<SmokeRunResult>;
}

/** Parks a gated prod cutover / a failed release as a #13 owner decision. */
export interface ReleaseApprovalGate {
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    summary: string;
    payload: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

/** Files a self-healing incident for a failed release (reuses #193 `filePostmortem` + reporters). */
export interface ReleaseIncidentFiler {
  file(pm: OpsPostmortem): Promise<void>;
}

export class NoDeployTargetError extends Error {
  constructor(ventureId: string) {
    super(`venture-deploy: no provisioned target for venture ${ventureId}`);
    this.name = "NoDeployTargetError";
  }
}

export interface ReleasePipelineDeps {
  caps: (workspaceId: string) => VentureDeployCaps;
  targets: DeployTargetStore;
  releases: ReleaseStore;
  deployer: ReleaseDeployer;
  smoke: SmokeRunner;
  approvals?: ReleaseApprovalGate;
  incident?: ReleaseIncidentFiler;
  /** Resolve the venture's vault secrets to inject into the build (#192). Default ⇒ no secrets. */
  resolveSecrets?: (workspaceId: string, serviceKey: string) => Promise<Record<string, string>>;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  now?: () => Date;
}

export interface ReleaseInput {
  workspaceId: string;
  ventureId: string;
  /** The git sha / build ref being released (provenance). */
  releaseRef: string;
  /** The member the parked #13 decision is attributed to. */
  requesterMemberId: string;
}

export class VentureReleasePipeline {
  private readonly deps: ReleasePipelineDeps;
  private readonly now: () => Date;
  private readonly releaseLocks = new Map<string, Promise<void>>();

  constructor(deps: ReleasePipelineDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  async release(input: ReleaseInput): Promise<ReleaseReceipt> {
    return this.withReleaseLock(input, () => this.releaseLocked(input));
  }

  private async releaseLocked(input: ReleaseInput): Promise<ReleaseReceipt> {
    const { workspaceId, ventureId, releaseRef, requesterMemberId } = input;
    const existing = await this.deps.releases.getByRelease?.(workspaceId, ventureId, releaseRef);
    if (existing) return existing;

    const caps = this.deps.caps(workspaceId);

    const target = await this.deps.targets.getByVenture(workspaceId, ventureId);
    if (!target) throw new NoDeployTargetError(ventureId);

    const secrets = this.deps.resolveSecrets
      ? await this.deps.resolveSecrets(workspaceId, target.secretServiceKey)
      : {};

    // 1. Deploy the merged build to the PREVIEW target (never straight to customers).
    const deployOutcome = await this.deps.deployer.deployPreview({
      workspaceId,
      ventureId,
      targetId: target.id,
      previewUrl: target.previewUrl,
      releaseRef,
      secrets,
    });

    // 2. Smoke the live preview URL — the production-grounded release gate (#186/#171).
    let smoke: SmokeRunResult = { ran: false, criticalCount: -1, detail: deployOutcome.detail };
    if (deployOutcome.ok && deployOutcome.url) {
      smoke = await this.deps.smoke.run({ url: deployOutcome.url });
    }

    const prior = await this.deps.deployer.latestProd({ workspaceId, ventureId });
    const decision = decideRelease({
      caps,
      deployOk: deployOutcome.ok,
      smokeRan: smoke.ran,
      smokeCriticalCount: smoke.ran ? smoke.criticalCount : 0,
      hasRollbackTarget: Boolean(prior),
    });

    // 3. Act on the decision.
    let approvalRequestId: string | null = null;
    let url: string | null = deployOutcome.url;
    let detail = `${decision.reason}: ${deployOutcome.detail}`;
    let action = decision.action;
    let reversibility = decision.reversibility;
    let requiresApproval = decision.requiresApproval;
    let promoteHealthOk: boolean | null = null;
    let promoteHealthDetail: string | null = null;
    let promoteHealthIncident = false;
    let pendingReceipt: ReleaseReceipt | null = null;

    if (decision.action === "promote") {
      if (decision.requiresApproval) {
        // The cutover is parked as an owner #13 decision (recorded-only until approved, #200 §4) — the
        // good preview stays live; prod is NOT cut over autonomously.
        const req = await this.deps.approvals?.submit({
          workspaceId,
          requesterMemberId,
          summary: `Promote venture ${ventureId} release ${releaseRef} to production`,
          payload: { ventureId, releaseRef, targetId: target.id, action: "prod_promote" },
        });
        approvalRequestId = req?.id ?? null;
        detail = "smoke green — prod cutover parked for owner approval";
      } else {
        if (this.deps.releases.update) {
          pendingReceipt = await this.deps.releases.create({
            workspaceId,
            ventureId,
            targetId: target.id,
            releaseRef,
            status: "pending_promote",
            action: "promote",
            reversibility: decision.reversibility,
            requiresApproval: false,
            approvalRequestId: null,
            smokeCriticalCount: smoke.ran ? smoke.criticalCount : -1,
            promoteHealthOk: null,
            promoteHealthDetail: null,
            url: deployOutcome.url,
            incidentFiled: false,
            detail: "smoke green — prod cutover in progress",
          });
        }
        await this.deps.deployer.promote({
          workspaceId,
          ventureId,
          prodUrl: target.prodUrl,
          providerDeploymentId: deployOutcome.providerDeploymentId,
        });
        const promoteHealth = this.deps.deployer.healthCheck
          ? await this.deps.deployer.healthCheck(target.prodUrl)
          : { ok: true, detail: "post-promote health check unavailable" };
        promoteHealthOk = promoteHealth.ok;
        promoteHealthDetail = promoteHealth.detail;
        if (promoteHealth.ok) {
          url = target.prodUrl;
          detail = `smoke green — promoted to production; promote health ok: ${promoteHealth.detail}`;
        } else if (prior) {
          const rb = await this.deps.deployer.rollback({ workspaceId, ventureId, prior });
          action = "rollback";
          reversibility = "cheap";
          requiresApproval = false;
          url = rb.url;
          detail = `promote health failed: ${promoteHealth.detail} — rolled back to last good prod (${prior.url})`;
          promoteHealthIncident = true;
        } else {
          action = "escalate";
          reversibility = "reversible";
          requiresApproval = true;
          url = deployOutcome.url;
          detail = `promote health failed: ${promoteHealth.detail} — no rollback target; escalated`;
          promoteHealthIncident = true;
        }
      }
    } else if (decision.action === "rollback" && prior) {
      const rb = await this.deps.deployer.rollback({ workspaceId, ventureId, prior });
      url = rb.url;
      detail = `${decision.reason} — rolled back to last good prod (${prior.url})`;
    } else if (decision.action === "escalate" && this.deps.approvals) {
      const req = await this.deps.approvals.submit({
        workspaceId,
        requesterMemberId,
        summary: `Venture ${ventureId} release ${releaseRef} needs a human (${decision.reason})`,
        payload: { ventureId, releaseRef, targetId: target.id, action: "release_escalation" },
      });
      approvalRequestId = req.id;
      detail = `${decision.reason} — escalated to owner`;
    }

    // 4. File a self-healing incident on a failed release (#195 AC3 — feeds the #172 self-shipping loop).
    const incidentFiled =
      (decision.fileIncident || promoteHealthIncident) && Boolean(this.deps.incident);
    if (decision.fileIncident && this.deps.incident) {
      await this.deps.incident.file(
        this.buildIncident({ workspaceId, ventureId, releaseRef, decision, smoke, deployOutcome }),
      );
    }
    if (promoteHealthIncident && this.deps.incident) {
      await this.deps.incident.file(
        this.buildPromoteHealthIncident({
          workspaceId,
          ventureId,
          releaseRef,
          detail: promoteHealthDetail ?? "post-promote health check failed",
          rolledBack: action === "rollback",
        }),
      );
    }

    // 5. Append the immutable receipt (the audit trail, #195 AC4). A gated promote is parked, not done.
    const status =
      action === "promote" && requiresApproval
        ? "escalated"
        : releaseStatusFor(
            action,
            action === decision.action ? decision.reason : "promote_health_failed",
          );

    const finalReceipt = {
      workspaceId,
      ventureId,
      targetId: target.id,
      releaseRef,
      status,
      action,
      reversibility,
      requiresApproval,
      approvalRequestId,
      smokeCriticalCount: smoke.ran ? smoke.criticalCount : -1,
      promoteHealthOk,
      promoteHealthDetail,
      url,
      incidentFiled,
      detail,
    };
    if (pendingReceipt && this.deps.releases.update) {
      return this.deps.releases.update(pendingReceipt.id, finalReceipt);
    }
    return this.deps.releases.create(finalReceipt);
  }

  private buildIncident(args: {
    workspaceId: string;
    ventureId: string;
    releaseRef: string;
    decision: ReturnType<typeof decideRelease>;
    smoke: SmokeRunResult;
    deployOutcome: ReleaseDeployOutcome;
  }): OpsPostmortem {
    const { workspaceId, ventureId, releaseRef, decision, smoke, deployOutcome } = args;
    const surfaceKey = `venture-deploy:${ventureId}`;
    const at = this.now().toISOString();
    const rootCause = deployOutcome.ok
      ? `Post-deploy smoke found ${smoke.criticalCount} critical issue(s) on release ${releaseRef}: ${smoke.detail}`
      : `Deploy of release ${releaseRef} failed: ${deployOutcome.detail}`;
    return {
      signature: `${workspaceId}|${surfaceKey}|uptime`,
      workspaceId,
      surfaceKey,
      ventureLabel: `venture ${ventureId}`,
      signal: "uptime",
      action: decision.action === "rollback" ? "rollback" : "escalate",
      observed: smoke.ran ? smoke.criticalCount : 1,
      threshold: 0,
      timeline: [
        { at, event: `release ${releaseRef} deployed: ${deployOutcome.ok ? "ok" : "failed"}` },
        {
          at,
          event: `smoke ${smoke.ran ? `ran (${smoke.criticalCount} critical)` : "did not run"}`,
        },
        { at, event: `decision: ${decision.action} (${decision.reason})` },
      ],
      rootCause,
      missingCheck:
        "A post-deploy smoke against the live preview URL before promotion — already the gate here; the " +
        "incident records that it caught a broken image and the venture stayed on its last good prod.",
    };
  }

  private buildPromoteHealthIncident(args: {
    workspaceId: string;
    ventureId: string;
    releaseRef: string;
    detail: string;
    rolledBack: boolean;
  }): OpsPostmortem {
    const { workspaceId, ventureId, releaseRef, detail, rolledBack } = args;
    const surfaceKey = `venture-deploy:${ventureId}`;
    const at = this.now().toISOString();
    return {
      signature: `${workspaceId}|${surfaceKey}|uptime`,
      workspaceId,
      surfaceKey,
      ventureLabel: `venture ${ventureId}`,
      signal: "uptime",
      action: rolledBack ? "rollback" : "escalate",
      observed: 1,
      threshold: 0,
      timeline: [
        { at, event: `release ${releaseRef} promoted to prod` },
        { at, event: `post-promote health failed: ${detail}` },
        {
          at,
          event: rolledBack
            ? "decision: rollback to prior prod"
            : "decision: escalate; no rollback target",
        },
      ],
      rootCause: `Post-promote production health check failed for release ${releaseRef}: ${detail}`,
      missingCheck:
        "A post-promote probe of the customer-facing production URL before recording a promoted receipt.",
    };
  }

  private async withReleaseLock<T>(input: ReleaseInput, fn: () => Promise<T>): Promise<T> {
    const key = `${input.workspaceId}|${input.ventureId}`;
    const previous = this.releaseLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.releaseLocks.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.releaseLocks.get(key) === chained) this.releaseLocks.delete(key);
    }
  }
}

/**
 * Adapt a {@link VentureReleasePipeline} to the build-loop's optional `PostMergeVerifier` seam so a
 * merged venture run runs the full deploy → smoke → promote/rollback pipeline (#195 AC2). `resolveVenture`
 * maps a build-loop run to a venture release (returns null for a non-venture run, e.g. agent-skills'
 * own self-shipping — in which case this is a byte-for-byte no-op so wiring it in is safe). The returned
 * `regressions` count drives the build-loop's existing escalation: a promoted release is 0 regressions, a
 * rolled-back / escalated / failed release surfaces ≥1 so the loop also escalates.
 */
export function releasePipelineAsPostMergeVerifier(
  pipeline: VentureReleasePipeline,
  resolveVenture: (run: { workspaceId: string; issueRef: string }) => {
    ventureId: string;
    releaseRef: string;
    requesterMemberId: string;
  } | null,
): {
  verify(input: {
    workspaceId: string;
    run: { workspaceId: string; issueRef: string };
  }): Promise<{ regressions: number; detail: string }>;
} {
  return {
    async verify({ workspaceId, run }) {
      const v = resolveVenture(run);
      if (!v) return { regressions: 0, detail: "not a venture repo — no venture release" };
      const receipt = await pipeline.release({
        workspaceId,
        ventureId: v.ventureId,
        releaseRef: v.releaseRef,
        requesterMemberId: v.requesterMemberId,
      });
      const regressions =
        receipt.status === "promoted" ? 0 : Math.max(receipt.smokeCriticalCount, 1); // any non-promote surfaces ≥1 so the loop escalates
      return { regressions, detail: receipt.detail };
    },
  };
}
