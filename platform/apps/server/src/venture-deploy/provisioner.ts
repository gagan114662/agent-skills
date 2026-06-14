import type { VentureDeployCaps } from "./caps.js";
import { decideProvision } from "./decide.js";
import { createInfraProvider } from "./factory.js";
import type { VentureInfraProvider } from "./provider.js";
import type { DeployTargetStore } from "./store.js";

/**
 * Provisions a venture's deploy target at bootstrap (#195 AC1) — structurally a
 * {@link import("../venture-factory/service.js").DeployTargetProvisioner} the factory injects on the
 * reversible `repo_deploy_target` step. It is **idempotent** (a re-run short-circuits on the existing
 * `(workspace, venture)` target), **budget-capped** (infra spend is charged through the venture's #71
 * ceiling AND a hard per-venture cap), and **default-OFF** (the pure {@link decideProvision} gates on
 * `enabled` + `ownerWorkspaceOnly`). Tenant scoping at the infra layer: each venture gets its OWN
 * `projectId` from its OWN vault service-key (`venture-deploy:<ventureId>`), so there is no cross-venture
 * infra access (AC5).
 */

/** Charge tenant usage for infra spend; false ⇒ the venture's budget ceiling would be crossed (#71). */
export interface ProvisionBudget {
  charge(workspaceId: string, cents: number, reason: string): Promise<boolean>;
}

export interface ProvisionerDeps {
  caps: (workspaceId: string) => VentureDeployCaps;
  /** Whether `workspaceId` is the owner's own workspace (gates `ownerWorkspaceOnly`). */
  isOwnerWorkspace: (workspaceId: string) => Promise<boolean>;
  targets: DeployTargetStore;
  budget: ProvisionBudget;
  /** Estimated one-time provisioning spend (cents) — checked against the cap BEFORE any spend. */
  estimateSetupCents?: number;
  /** Inject a fake provider in tests; otherwise the configured backend is built from `caps.provider`. */
  infra?: VentureInfraProvider;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  now?: () => Date;
}

/** Build a DNS-safe, globally-unique project slug from the venture name + a short id suffix. */
export function ventureSlug(ventureName: string, ventureId: string): string {
  const base = ventureName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = ventureId.replace(/-/g, "").slice(0, 8);
  return `${base || "venture"}-${suffix}`;
}

export class VentureDeployProvisioner {
  private readonly deps: ProvisionerDeps;

  constructor(deps: ProvisionerDeps) {
    this.deps = deps;
  }

  async provision(input: {
    workspaceId: string;
    ventureId: string;
    ventureName: string;
    createdByMemberId: string;
  }): Promise<void> {
    const { workspaceId, ventureId, ventureName } = input;
    const caps = this.deps.caps(workspaceId);

    const existing = await this.deps.targets.getByVenture(workspaceId, ventureId);
    const isOwner = caps.ownerWorkspaceOnly ? await this.deps.isOwnerWorkspace(workspaceId) : true;
    const estimate = this.deps.estimateSetupCents ?? 0;

    const decision = decideProvision({
      caps,
      isOwnerWorkspace: isOwner,
      alreadyProvisioned: Boolean(existing),
      estimatedSetupCents: estimate,
    });
    if (decision.action !== "provision") {
      this.deps.logger?.info?.(`venture-deploy provision skipped (${decision.reason}) for ${ventureId}`);
      return;
    }

    // Infra spend goes through the venture's #71 budget ceiling — a refusal means no provisioning runs
    // (the reversible step simply retries on a later tick once the budget frees up).
    const charged = await this.deps.budget.charge(workspaceId, estimate, "venture deploy provision");
    if (!charged) {
      this.deps.logger?.warn?.(`venture-deploy provision over budget for ${ventureId}`);
      return;
    }

    const infra = this.deps.infra ?? (await createInfraProvider(caps.provider));
    const slug = ventureSlug(ventureName, ventureId);
    const secretServiceKey = `venture-deploy:${ventureId}`;
    const logs: string[] = [];
    try {
      const outcome = await infra.provisionTarget({
        workspaceId,
        ventureId,
        slug,
        env: {},
        secrets: {},
        onLog: (line) => logs.push(line),
      });
      await this.deps.targets.create({
        workspaceId,
        ventureId,
        provider: infra.kind,
        projectId: outcome.projectId,
        previewUrl: outcome.previewUrl,
        prodUrl: outcome.prodUrl,
        status: "provisioned",
        secretServiceKey,
      });
      this.deps.logger?.info?.(`venture-deploy target provisioned for ${ventureId}: ${outcome.prodUrl}`);
    } catch (err) {
      // A provisioning failure is reversible — log and leave the venture unprovisioned so a later tick
      // retries; never abort the rest of the bootstrap.
      this.deps.logger?.warn?.(
        `venture-deploy provision failed for ${ventureId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
