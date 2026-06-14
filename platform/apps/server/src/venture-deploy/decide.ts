import type { VentureDeployCaps } from "./caps.js";
import type { ReleaseAction, ProvisionAction, ReversibilityClass } from "./types.js";

/**
 * The two pure decisions for Venture Deploys (#195, ADR-0195). **Pure + unit-tested**: the orchestrators
 * do the side effects (charge the budget, call the infra provider, deploy via #73, run the #171 smoke,
 * roll back, file the #193 incident, write the receipt); these functions just decide. Same split as
 * #193 `decideRemediation` / #187 `decideEdgeGate`.
 */

// ---- decideProvision: per-venture target provisioning (#195 AC1) ------------------------------

export interface ProvisionDecisionInput {
  caps: VentureDeployCaps;
  /** Whether this workspace is the owner's own workspace (gates `ownerWorkspaceOnly`). */
  isOwnerWorkspace: boolean;
  /** A target already exists for `(workspace, venture)` — provisioning is idempotent (a no-op re-run). */
  alreadyProvisioned: boolean;
  /** The estimated one-time provisioning spend, compared against the hard per-venture cap. */
  estimatedSetupCents: number;
}

export interface ProvisionDecision {
  action: ProvisionAction;
  reversibility: ReversibilityClass;
  reason: string;
}

/**
 * Decide whether to provision a venture's deploy target. **Fail-closed + idempotent**: anything we are
 * not enabled/allowed to do, or that already exists, is a clean skip — provisioning never runs twice for
 * a venture (the `(workspace, venture)` unique key + this gate). Provisioning a preview target is fully
 * `reversible` (it can be torn down), so it auto-runs inside the bootstrap loop; the only spend guard is
 * the hard per-venture cap here plus the tenant ceiling the caller charges (#71).
 */
export function decideProvision(input: ProvisionDecisionInput): ProvisionDecision {
  const { caps, isOwnerWorkspace, alreadyProvisioned, estimatedSetupCents } = input;

  if (!caps.enabled) {
    return { action: "skip_disabled", reversibility: "reversible", reason: "feature_disabled" };
  }
  if (caps.ownerWorkspaceOnly && !isOwnerWorkspace) {
    return { action: "skip_not_owner", reversibility: "reversible", reason: "owner_workspace_only" };
  }
  // Idempotency BEFORE the cap: a re-run of an already-provisioned venture is always a free no-op.
  if (alreadyProvisioned) {
    return { action: "skip_exists", reversibility: "reversible", reason: "already_provisioned" };
  }
  if (estimatedSetupCents > caps.infraSetupCapCents) {
    return { action: "skip_over_cap", reversibility: "reversible", reason: "over_infra_setup_cap" };
  }
  return { action: "provision", reversibility: "reversible", reason: "provision" };
}

// ---- decideRelease: the production-grounded release gate (#195 AC2/AC3) ------------------------

export interface ReleaseDecisionInput {
  caps: VentureDeployCaps;
  /** Did the deploy of the merged build to the preview target succeed (#73 outcome)? */
  deployOk: boolean;
  /**
   * Did the #171 smoke actually run against the live preview URL? A release that did NOT smoke-test
   * reality is NEVER promotable (#200 §3 — production-grounded verification is the only final tier).
   */
  smokeRan: boolean;
  /** Number of critical smoke findings (only meaningful when `smokeRan`). */
  smokeCriticalCount: number;
  /** Is there a prior good prod deploy to roll back to? */
  hasRollbackTarget: boolean;
}

export interface ReleaseDecision {
  action: ReleaseAction;
  reversibility: ReversibilityClass;
  /** Whether the action must clear a #13 human approval before it runs (a gated prod cutover). */
  requiresApproval: boolean;
  /** Whether this release should file a self-healing incident (a failed smoke / regression — #195 AC3). */
  fileIncident: boolean;
  /** Why — surfaced in the receipt + the daily brief and asserted in tests. */
  reason: string;
}

/**
 * Decide what to do at the release gate after a merged venture build has deployed to its preview target
 * and a smoke probe has (or has not) run. **A broken image must never reach customers (#195 AC2)** and a
 * release that didn't touch reality must never be treated as green (#200 §3), so the only path to
 * `promote` is: the deploy succeeded AND the smoke actually ran AND found zero critical findings.
 *
 * Priority (fail-closed):
 *   1. deploy failed              → rollback (if pre-committed + a target) else escalate; files an incident
 *   2. smoke did not run          → escalate (NEVER promote on an untested release); files an incident
 *   3. smoke found a critical bug → rollback (pre-committed safety, #195 AC3) else escalate; files an incident
 *   4. smoke green                → promote (the prod cutover; #13-gated unless the owner pre-committed)
 *
 * Rollback is the pre-committed bounded safety action (`autoRollbackOnSmokeFail`, default ON) and so runs
 * WITHOUT a per-release approval — that flag IS the pre-commitment. The prod promote is `cheap`
 * (re-promotable to the prior prod deploy) but customer-facing, so it stays approval-gated by default
 * (`requireApprovalForProdPromote`) until the owner pre-commits autonomous promotes (#200 §4).
 */
export function decideRelease(input: ReleaseDecisionInput): ReleaseDecision {
  const { caps, deployOk, smokeRan, smokeCriticalCount, hasRollbackTarget } = input;

  const rollbackOrEscalate = (reason: string): ReleaseDecision => {
    if (caps.autoRollbackOnSmokeFail && hasRollbackTarget) {
      return {
        action: "rollback",
        reversibility: "cheap",
        requiresApproval: false, // the autoRollbackOnSmokeFail cap IS the pre-commitment
        fileIncident: caps.fileIncidentOnFailure,
        reason,
      };
    }
    return {
      action: "escalate",
      reversibility: "reversible",
      requiresApproval: true,
      fileIncident: caps.fileIncidentOnFailure,
      reason: hasRollbackTarget ? `${reason}_no_autorollback` : `${reason}_no_target`,
    };
  };

  if (!deployOk) return rollbackOrEscalate("deploy_failed");
  if (!smokeRan) {
    // Production-grounded: an absent smoke is not a pass. Escalate rather than ship blind (#200 §3).
    return {
      action: "escalate",
      reversibility: "reversible",
      requiresApproval: true,
      fileIncident: caps.fileIncidentOnFailure,
      reason: "smoke_did_not_run",
    };
  }
  if (smokeCriticalCount > 0) return rollbackOrEscalate("smoke_failed");

  // Smoke is green AND it really ran: promote to prod (the customer-facing cutover).
  const requiresApproval = caps.requireApprovalForProdPromote && !caps.preCommitProdPromote;
  return {
    action: "promote",
    reversibility: "cheap",
    requiresApproval,
    fileIncident: false,
    reason: requiresApproval ? "smoke_green_promote_gated" : "smoke_green_promote",
  };
}

/** Map a release decision to the durable {@link import("./types.js").ReleaseStatus}. */
export function releaseStatusFor(action: ReleaseAction, reason: string): import("./types.js").ReleaseStatus {
  if (action === "promote") return "promoted";
  if (action === "rollback") return "rolled_back";
  if (reason.startsWith("deploy_failed")) return "deploy_failed";
  if (reason.startsWith("smoke")) return "smoke_failed";
  return "escalated";
}
