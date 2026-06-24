import type {
  ProvisionTargetInput,
  ProvisionTargetOutcome,
  VentureInfraProvider,
} from "./provider.js";
import { isTransientHttpStatus, retryWithBackoff, RetryableHttpError } from "../reliability/retry-backoff.js";

/**
 * Production adapter that provisions a venture's target on Fly.io — the same backend ipop itself runs on
 * (`fly.toml`, `fly-deploy.yml`). It creates a tenant-scoped prod app `<slug>` and a `<slug>-preview`
 * app (so smoke runs on preview before any prod cutover), both with automatic `*.fly.dev` SSL. It is
 * **dependency-free** (the Fly Machines REST API over global `fetch`, no SDK) and **lazy** (only ever
 * constructed when `provider: "fly"` is configured). Re-provisioning an existing app is idempotent —
 * Fly's 409/"already exists" is treated as success, so the orchestrator's re-runs are byte-identical.
 *
 * Auth: `VENTURE_DEPLOY_FLY_TOKEN` (falls back to `FLY_API_TOKEN`) + `VENTURE_DEPLOY_FLY_ORG`. Secrets
 * are NOT set here — they live in the per-venture vault and are injected at deploy time by the #73
 * `DeployManager`, so a poisoned read can never reach this provisioning path.
 */
export class FlyInfraProvider implements VentureInfraProvider {
  readonly kind = "fly" as const;

  private readonly api = "https://api.machines.dev/v1";

  private token(): string {
    const token = process.env.VENTURE_DEPLOY_FLY_TOKEN ?? process.env.FLY_API_TOKEN;
    if (!token) {
      throw new Error(
        "provider: \"fly\" requires VENTURE_DEPLOY_FLY_TOKEN (or FLY_API_TOKEN) and VENTURE_DEPLOY_FLY_ORG, " +
          "or run with the default dryrun provider.",
      );
    }
    return token;
  }

  private async createApp(appName: string, onLog: (line: string) => void): Promise<void> {
    const org = process.env.VENTURE_DEPLOY_FLY_ORG ?? "personal";
    const token = this.token();
    const res = await retryWithBackoff(
      async () => {
        const response = await fetch(`${this.api}/apps`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ app_name: appName, org_slug: org }),
        });
        if (!response.ok && response.status !== 409 && isTransientHttpStatus(response.status)) {
          const body = await response.text().catch(() => "");
          throw new RetryableHttpError(
            `fly app create failed for ${appName}: ${response.status} ${body.slice(0, 200)}`,
            response.status,
          );
        }
        return response;
      },
      {
        maxAttempts: 3,
        baseDelayMs: 50,
        shouldRetry: (err) => err instanceof RetryableHttpError,
      },
    );
    if (res.ok || res.status === 409) {
      onLog(`✓ fly app ${appName} ${res.status === 409 ? "exists" : "created"}`);
      return;
    }
    const body = await res.text().catch(() => "");
    throw new Error(`fly app create failed for ${appName}: ${res.status} ${body.slice(0, 200)}`);
  }

  async provisionTarget(input: ProvisionTargetInput): Promise<ProvisionTargetOutcome> {
    const prodApp = input.slug;
    const previewApp = `${input.slug}-preview`;
    input.onLog(`▸ provisioning fly target for ${input.slug}`);
    await this.createApp(prodApp, input.onLog);
    await this.createApp(previewApp, input.onLog);
    const setupCents = Number(process.env.VENTURE_DEPLOY_SETUP_CENTS ?? "0") || 0;
    return {
      projectId: prodApp,
      previewUrl: `https://${previewApp}.fly.dev`,
      prodUrl: `https://${prodApp}.fly.dev`,
      estimatedSetupCents: setupCents,
    };
  }

  async teardownTarget(projectId: string): Promise<void> {
    for (const app of [projectId, `${projectId}-preview`]) {
      await fetch(`${this.api}/apps/${app}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.token()}` },
      }).catch(() => undefined); // best-effort; safe on an already-removed app
    }
  }
}
