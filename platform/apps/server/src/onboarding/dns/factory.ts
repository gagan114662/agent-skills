import type { DnsProvider } from "./provider.js";
import { DryRunDnsProvider } from "./dry-run-provider.js";
import { CloudflareDnsProvider } from "./cloudflare-provider.js";

/** Non-secret DNS provider selection (the registrar SDK credentials live in the #192 vault, not here). */
export interface DnsEnv {
  /** `dryrun` (default) | a live adapter kind (`cloudflare`, …). */
  provider?: string;
  /**
   * The resolved per-workspace Cloudflare API token (#264). NOT a config value — the caller reads it from
   * the #192 write-only vault and passes it in here, so the factory itself never touches secrets storage.
   * When `provider: "cloudflare"` but no token resolves, the factory degrades to the safe dry-run default.
   */
  cloudflareToken?: string;
}

/**
 * Select the DNS backend (#192/#264), mirroring `createDeployProvider` (#73). `dryrun` is the default so
 * tests/CI/the demo need no network. A live adapter (Cloudflare today; GoDaddy/Namecheap/Route53 slot in
 * as sibling cases behind the same {@link DnsProvider} contract) is selected by `env.provider` AND a
 * resolved credential — a selected-but-unconnected provider degrades to dry-run rather than throwing, so
 * misconfiguration is never fatal. A provider can be injected (tests pass a fake); when omitted env selects.
 */
export function createDnsProvider(env: DnsEnv = {}, provider?: DnsProvider): DnsProvider {
  if (provider) return provider;
  switch (env.provider) {
    case "cloudflare":
      // Only go live when a token actually resolved; otherwise fall through to the no-network default so a
      // workspace that selected Cloudflare but hasn't connected a token degrades safely (never throws).
      if (env.cloudflareToken) return new CloudflareDnsProvider({ token: env.cloudflareToken });
      return new DryRunDnsProvider();
    case "dryrun":
    default:
      return new DryRunDnsProvider();
  }
}
