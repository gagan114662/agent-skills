import { loadEnv } from "../env.js";
import { EnvSecretsResolver } from "../runtime/secrets-resolver.js";
import { channelPoster } from "../runtime/default.js";
import { dbBillingStore } from "../db/repositories/billing.js";
import { dbDeploymentStore } from "../db/repositories/deployments.js";
import { dbPlanPriceStore, dbWorkspacePlanStore } from "../db/repositories/plans.js";
import type { SessionLogger } from "../runtime/manager.js";
import { createBillingProvider } from "./factory.js";
import { BillingManager, type DeploymentLookup } from "./manager.js";
import { PlanBillingService } from "./plan-service.js";

/**
 * Build the production billing surface (#98 + #125). The provider defaults to the no-network `none`
 * backend (`BILLING_PROVIDER=stripe` switches to the real adapter, loaded lazily). Secrets are resolved
 * per tenant via the #25 path; the channel post + persistence reuse the shared primitives. The #125
 * {@link PlanBillingService} (catalog + workspace-scoped checkout) shares the same provider + secrets and
 * is wired into the manager as the `planActivator` so a `plan_checkout` webhook activates the plan.
 */
export function createDefaultBilling(logger: SessionLogger): {
  billingManager: BillingManager;
  planService: PlanBillingService;
} {
  const env = loadEnv();
  const provider = createBillingProvider(env.billing);
  const secrets = new EnvSecretsResolver();
  const deployments: DeploymentLookup = {
    latestForSession: (sessionId, channelId) =>
      dbDeploymentStore.latestForSession(sessionId, channelId),
  };
  const planService = new PlanBillingService({
    provider,
    prices: dbPlanPriceStore,
    plans: dbWorkspacePlanStore,
    secrets,
    logger,
  });
  const billingManager = new BillingManager({
    provider,
    store: dbBillingStore,
    poster: channelPoster,
    secrets,
    deployments,
    planActivator: planService,
    toleranceSec: env.billing.webhookToleranceSeconds,
    logger,
  });
  return { billingManager, planService };
}

/** Back-compat helper: just the BillingManager (consumed by the founder console #104). */
export function createDefaultBillingManager(logger: SessionLogger): BillingManager {
  return createDefaultBilling(logger).billingManager;
}
