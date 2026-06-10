import type { DeployStack } from "./detect.js";

/**
 * Provider seam for managed hosting (#73), mirroring the #25 `SandboxProvider`. The real Vercel
 * adapter implements this behind a dynamic import (see ./vercel-provider.ts) so the SDK is an
 * OPTIONAL dependency the test/CI path never loads; the default `DryRunDeployProvider` implements the
 * whole surface with zero cloud spend so tests, CI, and the demo run for free.
 *
 * A deploy is a one-shot async job that yields a durable, immutable deployment (the provider's
 * deployment id never changes) — the deployment history IS the backup set, and rollback re-promotes a
 * prior one. Secrets are injected into the build but their values are redacted from all output
 * UPSTREAM by the manager (this interface streams raw lines via `onLog`).
 */
export interface DeployProvider {
  /** Stable provider kind (`dryrun` | `vercel`). */
  readonly kind: string;
  /** Build + deploy the app, streaming raw build lines; resolve with the live URL (or an error). */
  deploy(input: DeployInput): Promise<DeployOutcome>;
  /** Re-promote a prior immutable deployment (rollback / backups). Returns its live URL. */
  rollback(prior: PriorDeployment): Promise<DeployOutcome>;
  /**
   * Restart a deployment (auto-restart after a failed health check). Idempotent on the provider side.
   *
   * Semantics differ per provider and callers must not assume a stateful reboot: the Vercel adapter
   * re-promotes the same immutable deployment id (serverless deployments are stateless), and the
   * `DryRunDeployProvider` is a pure no-op. There is no in-place process restart on any shipped provider.
   */
  restart(providerDeploymentId: string): Promise<void>;
  /**
   * Scale a deployment. The caller has already clamped to trusted-config bounds.
   *
   * Honest no-op on the shipped providers: Vercel autoscales serverless functions, so explicit
   * scaling is a project-settings change this adapter does **not** perform (it resolves without
   * effect); `DryRunDeployProvider` likewise records nothing. Treat `ScaleInput` as advisory until a
   * provider with real instance control is added.
   */
  scale(providerDeploymentId: string, scale: ScaleInput): Promise<void>;
  /** Probe a live URL's health (used by the opt-in monitor + the manual check). */
  healthCheck(url: string): Promise<HealthResult>;
}

export interface DeployInput {
  /** Our deployment row id (correlates the provider deployment to our record). */
  deploymentId: string;
  workspaceId: string;
  sessionId: string;
  /** A stable slug the dry-run provider mints a URL from (e.g. the channel/session). */
  slug: string;
  /** The agent's worktree to build from (the provisioner's cwd); undefined in hermetic tests. */
  cwd?: string;
  /** The detected/declared stack (framework + build + output). */
  stack: DeployStack;
  /** Non-secret build env. */
  env: Record<string, string>;
  /** Per-tenant secrets injected into the build; their values are redacted from output by the manager. */
  secrets: Record<string, string>;
  /** Stream one raw build/deploy log line (the manager redacts before persisting/publishing). */
  onLog: (line: string) => void;
}

export interface DeployOutcome {
  status: "ready" | "error";
  /** The live HTTPS URL when ready. */
  url?: string;
  /** The provider's immutable deployment id. */
  providerDeploymentId?: string;
  /** An error message when status is `error` (the manager redacts it before persisting/streaming). */
  error?: string;
}

/** A prior deployment to re-promote on rollback. */
export interface PriorDeployment {
  providerDeploymentId: string;
  url: string;
}

export interface ScaleInput {
  /** Desired instance count (already clamped to `deploy.maxInstances`). */
  instances?: number;
  /** Desired instance size keyword. */
  size?: string;
}

export interface HealthResult {
  healthy: boolean;
  detail?: string;
}
