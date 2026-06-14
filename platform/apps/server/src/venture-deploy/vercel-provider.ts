import type {
  ProvisionTargetInput,
  ProvisionTargetOutcome,
  VentureInfraProvider,
} from "./provider.js";

/**
 * Production adapter that provisions a venture's target as a Vercel project (managed HTTPS, preview +
 * production deployments built in). **Dependency-free** (the Vercel REST API over global `fetch`, no
 * SDK) and **lazy** (only constructed when `provider: "vercel"` is configured). Re-provisioning is
 * idempotent — a "project already exists" conflict is treated as success.
 *
 * Auth: `VERCEL_TOKEN` (+ optional `VERCEL_TEAM_ID`). Secrets are NOT set here — they live in the
 * per-venture vault and are injected at deploy time by the #73 `DeployManager`.
 */
export class VercelInfraProvider implements VentureInfraProvider {
  readonly kind = "vercel" as const;

  private readonly api = "https://api.vercel.com";

  private token(): string {
    const token = process.env.VERCEL_TOKEN;
    if (!token) {
      throw new Error(
        "provider: \"vercel\" requires VERCEL_TOKEN (+ optional VERCEL_TEAM_ID), or run with the " +
          "default dryrun provider.",
      );
    }
    return token;
  }

  private teamQuery(): string {
    const team = process.env.VERCEL_TEAM_ID;
    return team ? `?teamId=${encodeURIComponent(team)}` : "";
  }

  async provisionTarget(input: ProvisionTargetInput): Promise<ProvisionTargetOutcome> {
    input.onLog(`▸ provisioning vercel project for ${input.slug}`);
    const res = await fetch(`${this.api}/v9/projects${this.teamQuery()}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.slug }),
    });
    if (!res.ok && res.status !== 409) {
      const body = await res.text().catch(() => "");
      throw new Error(`vercel project create failed for ${input.slug}: ${res.status} ${body.slice(0, 200)}`);
    }
    input.onLog(`✓ vercel project ${input.slug} ${res.status === 409 ? "exists" : "created"}`);
    const setupCents = Number(process.env.VENTURE_DEPLOY_SETUP_CENTS ?? "0") || 0;
    return {
      projectId: input.slug,
      previewUrl: `https://${input.slug}-preview.vercel.app`,
      prodUrl: `https://${input.slug}.vercel.app`,
      estimatedSetupCents: setupCents,
    };
  }

  async teardownTarget(projectId: string): Promise<void> {
    await fetch(`${this.api}/v9/projects/${encodeURIComponent(projectId)}${this.teamQuery()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.token()}` },
    }).catch(() => undefined); // best-effort
  }
}
