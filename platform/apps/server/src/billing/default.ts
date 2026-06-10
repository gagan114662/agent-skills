import { loadEnv } from "../env.js";
import { EnvSecretsResolver } from "../runtime/secrets-resolver.js";
import { channelPoster } from "../runtime/default.js";
import { dbBillingStore } from "../db/repositories/billing.js";
import { dbDeploymentStore } from "../db/repositories/deployments.js";
import type { SessionLogger } from "../runtime/manager.js";
import { createBillingProvider } from "./factory.js";
import { BillingManager, type DeploymentLookup } from "./manager.js";

/**
 * Build the production BillingManager (#98, ADR-0043). The provider defaults to the no-network `none`
 * backend (`BILLING_PROVIDER=stripe` switches to the real adapter, loaded lazily). Secrets are resolved
 * per tenant via the #25 path; the channel post + persistence reuse the shared primitives. The deployment
 * lookup attaches a payment link to the session's latest deployment record.
 */
export function createDefaultBillingManager(logger: SessionLogger): BillingManager {
  const env = loadEnv();
  const deployments: DeploymentLookup = {
    latestForSession: (sessionId, channelId) =>
      dbDeploymentStore.latestForSession(sessionId, channelId),
  };
  return new BillingManager({
    provider: createBillingProvider(env.billing),
    store: dbBillingStore,
    poster: channelPoster,
    secrets: new EnvSecretsResolver(),
    deployments,
    toleranceSec: env.billing.webhookToleranceSeconds,
    logger,
  });
}
