import type { DnsProvider } from "./provider.js";
import { DryRunDnsProvider } from "./dry-run-provider.js";

/** Non-secret DNS provider selection (the registrar SDK credentials live in the #192 vault, not here). */
export interface DnsEnv {
  /** `dryrun` (default) | a live adapter kind. */
  provider?: string;
}

/**
 * Select the DNS backend (#192), mirroring `createDeployProvider` (#73). `dryrun` is the default so
 * tests/CI/the demo need no network; a real provider kind would return a lazily-loaded adapter (the SDK
 * stays an optional dependency the default path never imports). A provider can be injected (tests pass a
 * fake); when omitted the env selects.
 */
export function createDnsProvider(env: DnsEnv = {}, provider?: DnsProvider): DnsProvider {
  if (provider) return provider;
  switch (env.provider) {
    // Live adapters (e.g. Cloudflare) would be dynamically imported per case here so their SDK stays an
    // optional dependency the default path never loads. Until one ships, any selection falls through to
    // the safe no-network default rather than throwing — so misconfiguration degrades to dry-run.
    case "dryrun":
    default:
      return new DryRunDnsProvider();
  }
}
