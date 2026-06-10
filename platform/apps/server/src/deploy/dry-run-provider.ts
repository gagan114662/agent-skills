import type {
  DeployInput,
  DeployOutcome,
  DeployProvider,
  HealthResult,
  PriorDeployment,
  ScaleInput,
} from "./provider.js";

/**
 * The default, **no-cloud-spend** deploy provider (#73). It exercises the entire surface — returning a
 * deterministic `https://<slug>.dryrun.reload.app` URL, streaming a couple of synthetic build lines
 * (one of which intentionally echoes any injected secret so the redaction test is real), and recording
 * its calls — so tests, CI, and the demo never touch a cloud account. The real backend is
 * `VercelDeployProvider` behind a lazy import (`DEPLOY_PROVIDER=vercel`).
 *
 * It is also the seam for controllable behavior in tests: `failNext`/`unhealthy` let a test force an
 * error or a failing health check without any provider-specific machinery.
 */
export class DryRunDeployProvider implements DeployProvider {
  readonly kind = "dryrun";

  /** Calls recorded for assertions (no cloud side effects). */
  readonly deployed: DeployInput[] = [];
  readonly restarted: string[] = [];
  readonly scaled: { id: string; scale: ScaleInput }[] = [];

  /** When set, the next `deploy` resolves as an error (then resets). */
  failNext?: string;
  /** When set, `healthCheck` reports unhealthy. */
  unhealthy = false;
  /** When false, a `restart` does NOT clear the unhealthy state (simulates an unrecoverable outage). */
  restartRecovers = true;

  private seq = 0;

  deploy(input: DeployInput): Promise<DeployOutcome> {
    this.deployed.push(input);
    input.onLog(`▸ building ${input.stack.framework} (${input.stack.buildCommand ?? "no build"})`);
    // Echo the build env so a leaked secret WOULD show up here — the manager's redactor must scrub it.
    for (const [k, v] of Object.entries(input.secrets)) input.onLog(`  env ${k}=${v}`);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      input.onLog(`✗ build failed: ${error}`);
      return Promise.resolve({ status: "error", error });
    }
    const providerDeploymentId = `dpl_${input.deploymentId}_${++this.seq}`;
    const url = `https://${input.slug}.dryrun.reload.app`;
    input.onLog(`✓ deployed to ${url}`);
    return Promise.resolve({ status: "ready", url, providerDeploymentId });
  }

  rollback(prior: PriorDeployment): Promise<DeployOutcome> {
    // Re-promote the prior immutable deployment: its URL comes back live, unchanged.
    return Promise.resolve({
      status: "ready",
      url: prior.url,
      providerDeploymentId: prior.providerDeploymentId,
    });
  }

  restart(providerDeploymentId: string): Promise<void> {
    this.restarted.push(providerDeploymentId);
    // A restart clears the simulated unhealthy state (the app comes back) unless told it can't.
    if (this.restartRecovers) this.unhealthy = false;
    return Promise.resolve();
  }

  scale(providerDeploymentId: string, scale: ScaleInput): Promise<void> {
    this.scaled.push({ id: providerDeploymentId, scale });
    return Promise.resolve();
  }

  healthCheck(_url: string): Promise<HealthResult> {
    return Promise.resolve(
      this.unhealthy ? { healthy: false, detail: "simulated outage" } : { healthy: true },
    );
  }
}
