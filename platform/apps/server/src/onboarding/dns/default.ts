import { DnsManager } from "./manager.js";
import { createDnsProvider } from "./factory.js";
import { resolveOnboardingCaps } from "../caps.js";
import { loadConfig } from "../../config/loader.js";
import { resolveServiceSecrets } from "../../db/repositories/external-credentials.js";
import { recordDnsReceipts } from "../../db/repositories/dns-receipts.js";

/**
 * The vault service-key + env var the Cloudflare connector's token is stored/resolved under (#264). The
 * user pastes the token ONCE via the write-only onboarding connect route (kind `registrar` → autonomous,
 * not a money action) — it is sealed in the #192 vault and resolved here per-workspace, NEVER echoed.
 * `CLOUDFLARE_API_TOKEN` is also honored as a server-wide env fallback (mirrors `REALWORLD_GITHUB_TOKEN`).
 */
export const CLOUDFLARE_SERVICE_KEY = "cloudflare";
export const CLOUDFLARE_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";

/**
 * Wire the {@link DnsManager} to the real repos (#264). The provider is resolved PER WORKSPACE: only when
 * `onboarding.dnsProvider: "cloudflare"` AND a token resolves (from the vault, else the env fallback) does
 * the live Cloudflare connector come up; otherwise the safe no-network dry-run provider is used. Reading
 * the token from the vault is the ONLY secret access here, and it goes straight into the connector — never
 * into a response. Receipts are appended to the immutable `dns_receipts` store.
 */
export function createDefaultDnsManager(): DnsManager {
  return new DnsManager({
    resolveProvider: async (workspaceId) => {
      const caps = resolveOnboardingCaps(loadConfig(workspaceId).onboarding);
      let cloudflareToken: string | undefined;
      if (caps.dnsProvider === "cloudflare") {
        const secrets = await resolveServiceSecrets(workspaceId, CLOUDFLARE_SERVICE_KEY);
        cloudflareToken = secrets[CLOUDFLARE_TOKEN_ENV] ?? process.env[CLOUDFLARE_TOKEN_ENV];
      }
      return createDnsProvider({ provider: caps.dnsProvider, cloudflareToken });
    },
    receipts: { record: (input) => recordDnsReceipts(input) },
  });
}
