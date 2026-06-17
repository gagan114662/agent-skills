/**
 * Production wiring for central provisioning (#267, ADR-0267). Builds a {@link ProvisioningService} from
 * the layered config (#58 → {@link resolveProvisioningCaps}), the #192 vault (the OWNER workspace holds the
 * central `central:<provider>` credentials), and the usage ledger repo.
 *
 * Default-OFF by construction: with no `provisioning.enabled` in config every resolve returns `disabled`
 * and no vault read happens. The central credential is read ONLY server-side here (never merged into an
 * agent env passthrough), so the customer never sees a key.
 */

import { loadConfig } from "../config/loader.js";
import {
  getServiceStatus,
  resolveServiceSecrets,
} from "../db/repositories/external-credentials.js";
import { dbProvisioningUsageStore } from "../db/repositories/provisioning-usage.js";
import { resolveProvisioningCaps, type ProvisioningCaps } from "./caps.js";
import { centralServiceKey } from "./registry.js";
import { EmptyCentralCredentialResolver, type CentralCredentialResolver } from "./provider.js";
import { ProvisioningService } from "./service.js";

/** Resolve a workspace's provisioning policy from the layered config. */
function loadCapsFor(workspaceId: string): ProvisioningCaps {
  return resolveProvisioningCaps(loadConfig(workspaceId).provisioning);
}

/**
 * The OWNER-vault-backed central credential resolver. Reads `central:<provider>` from the OWNER workspace's
 * #192 vault (NOT the calling customer's). When provisioning is off or no owner workspace is configured it
 * holds nothing — the caller degrades to mock. Server-side only.
 */
class OwnerVaultCentralCredentialResolver implements CentralCredentialResolver {
  constructor(private readonly ownerWorkspaceId: () => string | null) {}
  async resolveCentral(provider: string): Promise<Record<string, string>> {
    const owner = this.ownerWorkspaceId();
    if (!owner) return {};
    return resolveServiceSecrets(owner, centralServiceKey(provider));
  }
}

/**
 * Build the default {@link ProvisioningService}. The owner workspace id is resolved lazily from config each
 * call (so a config reload takes effect without a restart). `centralConnected` uses the vault STATUS API
 * (which never selects the secret column) so the read surface stays key-free.
 */
export function createDefaultProvisioningService(): ProvisioningService {
  const ownerWorkspaceId = (): string | null => {
    // The owner workspace is global to the deployment; resolve it from the base (no-workspace) config layer.
    return resolveProvisioningCaps(loadConfig().provisioning).ownerWorkspaceId;
  };
  const central = new OwnerVaultCentralCredentialResolver(ownerWorkspaceId);
  return new ProvisioningService({
    loadCaps: loadCapsFor,
    central,
    centralConnected: async (provider) => {
      const owner = ownerWorkspaceId();
      if (!owner) return false;
      const status = await getServiceStatus(owner, centralServiceKey(provider));
      return status?.connected === true;
    },
    usage: dbProvisioningUsageStore,
  });
}

/** A fully-inert service for the no-config / unit fallback — holds no credential, provisions nothing. */
export function createInertProvisioningService(): ProvisioningService {
  return new ProvisioningService({
    loadCaps: () => resolveProvisioningCaps(undefined),
    central: new EmptyCentralCredentialResolver(),
    centralConnected: async () => false,
    usage: { record: async () => {} },
  });
}
