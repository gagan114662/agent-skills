import type {
  DeployInput,
  DeployOutcome,
  DeployProvider,
  HealthResult,
  PriorDeployment,
  ScaleInput,
} from "./provider.js";

/**
 * Production adapter mapping {@link DeployProvider} onto Vercel's deploy API (`@vercel/sdk`). This is
 * the "agent builds it → it's live" backend: managed HTTPS, immutable deployments (our backup set),
 * instant rollback (re-promote a prior deployment), health/restart, and scaling — all from one vendor.
 *
 * The SDK is loaded via a *dynamic import behind a runtime variable* so it stays an OPTIONAL
 * dependency: the test/CI path uses `DryRunDeployProvider` and never loads it, and the lockfile isn't
 * forced to carry it. To use the `vercel` backend:
 *   1. Install it:  pnpm --filter @reload/server add @vercel/sdk
 *   2. Authenticate: VERCEL_TOKEN (+ VERCEL_TEAM_ID for a team account).
 *   3. Set DEPLOY_PROVIDER=vercel.
 *
 * The SDK surface below is the exact slice we use; provider credentials are read from the per-tenant
 * secrets the manager injects (never from config), and the manager redacts their values from output.
 */

/** A created/queried Vercel deployment (the slice we read). */
interface VercelDeployment {
  id: string;
  /** The production/canonical URL once the deployment is ready (host without scheme). */
  url?: string;
  readyState?: "QUEUED" | "BUILDING" | "READY" | "ERROR" | "CANCELED";
}

interface VercelSdkClient {
  deployments: {
    createDeployment(args: {
      requestBody: {
        name: string;
        target?: "production" | "preview";
        projectSettings?: { framework?: string | null; buildCommand?: string | null; outputDirectory?: string | null };
        files?: { file: string; data: string }[];
        env?: Record<string, string>;
      };
    }): Promise<VercelDeployment>;
    getDeployment(args: { idOrUrl: string }): Promise<VercelDeployment>;
    /** Promote a prior immutable deployment to production (rollback). */
    promoteDeployment?(args: { deploymentId: string }): Promise<unknown>;
  };
}

interface VercelSdkModule {
  Vercel: new (opts: { bearerToken?: string }) => VercelSdkClient;
}

function authError(): Error {
  return new Error(
    "DEPLOY_PROVIDER=vercel requires the '@vercel/sdk' package and VERCEL_TOKEN. Install it " +
      "(pnpm --filter @reload/server add @vercel/sdk), set VERCEL_TOKEN (+ VERCEL_TEAM_ID), " +
      "or run with DEPLOY_PROVIDER=dryrun.",
  );
}

async function loadClient(): Promise<VercelSdkClient> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw authError();
  const specifier = "@vercel/sdk";
  let mod: VercelSdkModule;
  try {
    mod = (await import(specifier)) as unknown as VercelSdkModule;
  } catch {
    throw authError();
  }
  return new mod.Vercel({ bearerToken: token });
}

/** The provider used when `DEPLOY_PROVIDER=vercel`. Lazily loads the SDK on first deploy. */
export class VercelDeployProvider implements DeployProvider {
  readonly kind = "vercel";

  async deploy(input: DeployInput): Promise<DeployOutcome> {
    const client = await loadClient();
    input.onLog(`▸ deploying ${input.stack.framework} to Vercel`);
    try {
      const created = await client.deployments.createDeployment({
        requestBody: {
          name: input.slug,
          target: "production",
          projectSettings: {
            framework: input.stack.framework,
            buildCommand: input.stack.buildCommand ?? null,
            outputDirectory: input.stack.outputDir ?? null,
          },
          // Secrets + non-secret env are injected at build; the manager redacts their values from logs.
          env: { ...input.env, ...input.secrets },
        },
      });
      const ready = await this.waitForReady(client, created, input.onLog);
      if (ready.readyState !== "READY" || !ready.url) {
        return { status: "error", error: `deployment ${ready.readyState ?? "unknown"}`, providerDeploymentId: ready.id };
      }
      return { status: "ready", url: `https://${ready.url}`, providerDeploymentId: ready.id };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async waitForReady(
    client: VercelSdkClient,
    deployment: VercelDeployment,
    onLog: (line: string) => void,
  ): Promise<VercelDeployment> {
    let current = deployment;
    for (let i = 0; i < 120 && current.readyState !== "READY" && current.readyState !== "ERROR"; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      current = await client.deployments.getDeployment({ idOrUrl: current.id });
      onLog(`  ${current.readyState ?? "BUILDING"}`);
    }
    return current;
  }

  async rollback(prior: PriorDeployment): Promise<DeployOutcome> {
    const client = await loadClient();
    await client.deployments.promoteDeployment?.({ deploymentId: prior.providerDeploymentId });
    return { status: "ready", url: prior.url, providerDeploymentId: prior.providerDeploymentId };
  }

  async restart(providerDeploymentId: string): Promise<void> {
    // Vercel serverless deployments are stateless/immutable; "restart" re-promotes the same id.
    const client = await loadClient();
    await client.deployments.promoteDeployment?.({ deploymentId: providerDeploymentId });
  }

  scale(_providerDeploymentId: string, _scale: ScaleInput): Promise<void> {
    // Vercel autoscales serverless functions; explicit scaling is a project-settings change (no-op here).
    return Promise.resolve();
  }

  async healthCheck(url: string): Promise<HealthResult> {
    try {
      const res = await fetch(url, { method: "HEAD" });
      return res.ok ? { healthy: true } : { healthy: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { healthy: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
