/**
 * Shared types for Venture Deploys (#195, ADR-0195). The pure `decide` module and the IO
 * `provisioner` / `release` orchestrators agree on these — the same pure-decision-in / side-effects-out
 * split as #193 self-healing, #73 deploy, and #187 venture-factory.
 *
 * The whole feature answers the #200 premortem: the release gate is production-grounded (§3 — a real
 * deploy + a real smoke probe of the live URL is the only path to a customer-facing promote), and every
 * action is reversibility-classed (§4 — the prod cutover is gated/pre-committed, the rollback is the
 * pre-committed safety action). It is **default OFF** and **owner-workspace first**.
 */

/**
 * The reversibility class of a venture-deploy action (#200 §4). Mirrors the self-healing union so the
 * console / audit speak one language. `reversible` = no lasting customer effect (provision a preview
 * target, deploy a build that can be rolled back); `cheap` = bounded blast radius + fast/cheap reversal
 * (a prod cutover that re-promotes to the prior prod deploy, a rollback); `irreversible` =
 * brand/legal/unbounded-money (a custom-domain cutover) — never auto-run, always pre-commit or human.
 */
export type ReversibilityClass = "reversible" | "cheap" | "irreversible";

/** The provisioning decision outcome (#195 AC1). */
export type ProvisionAction =
  | "provision"
  | "skip_exists"
  | "skip_disabled"
  | "skip_not_owner"
  | "skip_over_cap";

/** The release-gate decision outcome (#195 AC2/AC3). */
export type ReleaseAction = "promote" | "rollback" | "escalate";

/** The infra backend that owns a venture's deploy target. `dryrun` is the default, no-spend backend. */
export const INFRA_PROVIDER_KINDS = ["dryrun", "fly", "vercel"] as const;
export type InfraProviderKind = (typeof INFRA_PROVIDER_KINDS)[number];

/** The lifecycle of a provisioned per-venture deploy target. */
export const DEPLOY_TARGET_STATUSES = ["provisioned", "failed"] as const;
export type DeployTargetStatus = (typeof DEPLOY_TARGET_STATUSES)[number];

/**
 * A per-venture deploy target (one immutable row in `deploy_targets`). Provisioned ONCE per venture at
 * bootstrap; the unique `(workspace_id, venture_id)` key makes re-provisioning idempotent. The target
 * carries the tenant-scoped infra identity (`projectId` = the Fly app / Vercel project) — a release for
 * venture A can only ever resolve venture A's target, so there is no cross-venture infra access (AC5).
 */
export interface DeployTarget {
  id: string;
  workspaceId: string;
  ventureId: string;
  provider: InfraProviderKind;
  /** The provider-side project/app id (the tenant boundary at the infra layer). */
  projectId: string;
  /** The non-customer preview URL (smoke runs here before any prod cutover). */
  previewUrl: string;
  /** The customer-facing production URL. */
  prodUrl: string;
  status: DeployTargetStatus;
  /** The vault service-key holding this venture's deploy secrets (`venture-deploy:<ventureId>`). */
  secretServiceKey: string;
  createdAt: Date;
}

/** The lifecycle of a release attempt (one immutable row in `deploy_releases`). */
export const RELEASE_STATUSES = [
  "pending_promote",
  "deploy_failed",
  "smoke_failed",
  "rolled_back",
  "promoted",
  "escalated",
] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/**
 * An immutable release receipt (one row per release attempt in `deploy_releases`). This IS the audit
 * trail (AC4): every deploy / smoke / promote / rollback for a venture is a durable, redacted record the
 * daily brief reads.
 */
export interface ReleaseReceipt {
  id: string;
  workspaceId: string;
  ventureId: string;
  targetId: string;
  /** The git sha / build ref that was released (provenance). */
  releaseRef: string;
  status: ReleaseStatus;
  /** The action the pure decision chose. */
  action: ReleaseAction;
  reversibility: ReversibilityClass;
  /** Whether a #13 approval was required for this action (a gated prod cutover). */
  requiresApproval: boolean;
  approvalRequestId: string | null;
  /** Number of critical smoke findings (`-1` when smoke did not run — production-grounded, never a pass). */
  smokeCriticalCount: number;
  /** Post-promote production URL health result; null when no prod cutover ran. */
  promoteHealthOk: boolean | null;
  /** Redacted detail from the post-promote production health probe. */
  promoteHealthDetail: string | null;
  /** The live URL this release deployed to (preview), if the deploy succeeded. */
  url: string | null;
  /** Whether this release filed a self-healing incident (a failed smoke / regression). */
  incidentFiled: boolean;
  detail: string;
  createdAt: Date;
}
