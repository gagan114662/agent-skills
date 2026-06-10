import type { DeployEnv } from "../env.js";
import type { DeployProvider } from "./provider.js";
import { DryRunDeployProvider } from "./dry-run-provider.js";
import { VercelDeployProvider } from "./vercel-provider.js";

/**
 * Select the deploy backend from config (#73), mirroring `createRuntime` (#25). `dryrun` is the
 * default so tests/CI/the demo need no cloud spend; `vercel` returns the real adapter (the SDK is
 * loaded lazily on first deploy, so selecting it here never touches the package). A provider can be
 * injected (tests pass a fake) — when omitted the env selects.
 */
export function createDeployProvider(env: DeployEnv, provider?: DeployProvider): DeployProvider {
  if (provider) return provider;
  if (env.provider === "vercel") return new VercelDeployProvider();
  return new DryRunDeployProvider();
}
