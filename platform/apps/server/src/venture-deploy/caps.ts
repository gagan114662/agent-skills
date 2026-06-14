import type { VentureDeploysConfig } from "../config/schema.js";
import type { InfraProviderKind } from "./types.js";

/**
 * Resolve the Venture Deploys policy from the layered config (#58), applying hard defaults — mirrors
 * `self-healing/caps.ts` and `venture-factory/caps.ts`. The feature is **default OFF** (`enabled: false`)
 * and **owner-workspace first** (`ownerWorkspaceOnly: true`): a deployment that sets no `ventureDeploys`
 * section keeps today's behavior (no provisioning in the factory bootstrap, no release pipeline in the
 * build loop).
 *
 * The two safety switches answer the #200 premortem §4 (reversibility):
 *  - `autoRollbackOnSmokeFail` (default ON) — the pre-committed bounded safety action: a broken image is
 *    rolled back without a human (#195 AC3). Turn it OFF to escalate failed smokes instead.
 *  - `requireApprovalForProdPromote` (default ON) — the customer-facing cutover is gated by default; the
 *    owner opts into autonomous promotes with `preCommitProdPromote` (the pre-commitment, not post-hoc
 *    review). The preview deploy + smoke is always autonomous (fully reversible).
 */
export interface VentureDeployCaps {
  /** The feature flag. OFF by default. */
  enabled: boolean;
  /** Restrict to the owner's own workspace (default true — owner-workspace first). */
  ownerWorkspaceOnly: boolean;
  /** The infra backend. `dryrun` (no spend) by default. */
  provider: InfraProviderKind;
  /** Hard per-venture cap on one-time provisioning spend (cents). A larger estimate is refused. */
  infraSetupCapCents: number;
  /** Roll back a broken image without a human (the pre-committed safety action, #195 AC3). Default ON. */
  autoRollbackOnSmokeFail: boolean;
  /** Gate the prod cutover behind a #13 approval (default ON — the irreversible-ish action). */
  requireApprovalForProdPromote: boolean;
  /** Owner pre-committed the prod cutover: it may auto-run once smoke is green (#200 §4). Default OFF. */
  preCommitProdPromote: boolean;
  /** File a self-healing incident when a release fails / rolls back (default ON, #195 AC3). */
  fileIncidentOnFailure: boolean;
}

export const VENTURE_DEPLOY_DEFAULTS = {
  enabled: false,
  ownerWorkspaceOnly: true,
  provider: "dryrun" as InfraProviderKind,
  infraSetupCapCents: 5_000, // $50 one-time provisioning ceiling per venture
  autoRollbackOnSmokeFail: true,
  requireApprovalForProdPromote: true,
  preCommitProdPromote: false,
  fileIncidentOnFailure: true,
} as const;

export function resolveVentureDeployCaps(cfg: VentureDeploysConfig | undefined): VentureDeployCaps {
  return {
    enabled: cfg?.enabled ?? VENTURE_DEPLOY_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? VENTURE_DEPLOY_DEFAULTS.ownerWorkspaceOnly,
    provider: cfg?.provider ?? VENTURE_DEPLOY_DEFAULTS.provider,
    infraSetupCapCents: cfg?.infraSetupCapCents ?? VENTURE_DEPLOY_DEFAULTS.infraSetupCapCents,
    autoRollbackOnSmokeFail:
      cfg?.autoRollbackOnSmokeFail ?? VENTURE_DEPLOY_DEFAULTS.autoRollbackOnSmokeFail,
    requireApprovalForProdPromote:
      cfg?.requireApprovalForProdPromote ?? VENTURE_DEPLOY_DEFAULTS.requireApprovalForProdPromote,
    preCommitProdPromote: cfg?.preCommitProdPromote ?? VENTURE_DEPLOY_DEFAULTS.preCommitProdPromote,
    fileIncidentOnFailure: cfg?.fileIncidentOnFailure ?? VENTURE_DEPLOY_DEFAULTS.fileIncidentOnFailure,
  };
}
