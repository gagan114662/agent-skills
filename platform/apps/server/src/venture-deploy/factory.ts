import type { InfraProviderKind } from "./types.js";
import type { VentureInfraProvider } from "./provider.js";
import { DryRunInfraProvider } from "./dry-run-provider.js";

/**
 * Select the infra-provisioning backend from config (#195), mirroring #73 `createDeployProvider`.
 * `dryrun` is the default so tests/CI/the demo need no cloud spend; `fly`/`vercel` return the real
 * adapters (loaded behind `fetch`, so selecting them never touches a vendor SDK). A provider can be
 * injected (tests pass a fake) — when omitted the configured kind selects.
 *
 * The real adapters are dynamic-imported so a build that only ever runs `dryrun` does not pull their
 * modules into the hot path (and they stay trivially tree-shake-able).
 */
export async function createInfraProvider(
  kind: InfraProviderKind,
  provider?: VentureInfraProvider,
): Promise<VentureInfraProvider> {
  if (provider) return provider;
  if (kind === "fly") {
    const { FlyInfraProvider } = await import("./fly-provider.js");
    return new FlyInfraProvider();
  }
  if (kind === "vercel") {
    const { VercelInfraProvider } = await import("./vercel-provider.js");
    return new VercelInfraProvider();
  }
  return new DryRunInfraProvider();
}
