import type { DeployEnv } from "../env.js";
import type { DeployProvider } from "./provider.js";
import { DryRunDeployProvider } from "./dry-run-provider.js";
import { VercelDeployProvider } from "./vercel-provider.js";

export class DeployProviderCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployProviderCredentialError";
  }
}

export function assertDeployProviderCredentials(
  env: DeployEnv,
  source: NodeJS.ProcessEnv = process.env,
): void {
  if (env.provider !== "vercel") return;
  if (!source.VERCEL_TOKEN) {
    throw new DeployProviderCredentialError(
      "DEPLOY_PROVIDER=vercel requires VERCEL_TOKEN at startup; set it or use DEPLOY_PROVIDER=dryrun.",
    );
  }
}

/**
 * Select the deploy backend from config (#73), mirroring `createRuntime` (#25). `dryrun` is the
 * default so tests/CI/the demo need no cloud spend; `vercel` returns the real adapter (the SDK is
 * loaded lazily on first deploy, so selecting it here never touches the package). A provider can be
 * injected (tests pass a fake) — when omitted the env selects.
 */
export function createDeployProvider(
  env: DeployEnv,
  provider?: DeployProvider,
  source: NodeJS.ProcessEnv = process.env,
): DeployProvider {
  if (provider) return provider;
  assertDeployProviderCredentials(env, source);
  if (env.provider === "vercel") return new VercelDeployProvider();
  return new DryRunDeployProvider();
}
