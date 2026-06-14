import type { InfraProviderKind } from "./types.js";

/**
 * The infra-provisioning seam for Venture Deploys (#195), mirroring the #73 `DeployProvider` and #25
 * `SandboxProvider` shape. This provisions a venture's *target* (the Fly app / Vercel project + its
 * envs + SSL + a preview and a prod URL); the actual per-push build deploy into that target is the
 * existing #73 `DeployManager`. Real adapters live behind dynamic imports / fetch so no cloud SDK is a
 * hard dependency, and the default {@link import("./dry-run-provider.js").DryRunInfraProvider} implements
 * the whole surface with zero spend so tests, CI, and the demo run for free.
 *
 * Tenant scoping at the infra layer (AC5): each venture gets its OWN `projectId` (a separate app /
 * project), provisioned from the venture's own vault secrets — there is no shared project, so a release
 * for one venture can never reach another's infra.
 */
export interface VentureInfraProvider {
  /** Stable provider kind (`dryrun` | `fly` | `vercel`). */
  readonly kind: InfraProviderKind;
  /**
   * Idempotently create the per-venture target: the project/app, its build env + secrets, SSL, and a
   * preview + prod URL. Re-provisioning an existing project returns its identity unchanged (the safety
   * the orchestrator relies on for its own idempotency). Streams raw provisioning lines via `onLog`
   * (the caller redacts secret values before persisting/publishing).
   */
  provisionTarget(input: ProvisionTargetInput): Promise<ProvisionTargetOutcome>;
  /**
   * Tear down a target — the reversibility proof (#200 §4: provisioning a preview target is reversible).
   * Best-effort; safe to call on an already-removed target.
   */
  teardownTarget(projectId: string): Promise<void>;
}

export interface ProvisionTargetInput {
  workspaceId: string;
  ventureId: string;
  /** A stable, DNS-safe slug the provider derives the project name / URLs from. */
  slug: string;
  /** Non-secret build env. */
  env: Record<string, string>;
  /** The venture's vault secrets injected into the project; values redacted from output by the caller. */
  secrets: Record<string, string>;
  /** Stream one raw provisioning log line (the caller redacts before persisting/publishing). */
  onLog: (line: string) => void;
}

export interface ProvisionTargetOutcome {
  /** The provider-side project/app id — the tenant boundary at the infra layer. */
  projectId: string;
  /** The non-customer preview URL (smoke runs here before any prod cutover). */
  previewUrl: string;
  /** The customer-facing production URL. */
  prodUrl: string;
  /** What the provider expects to charge for this one-time setup (checked against the per-venture cap). */
  estimatedSetupCents: number;
}
