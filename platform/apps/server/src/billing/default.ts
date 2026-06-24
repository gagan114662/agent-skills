import { loadEnv } from "../env.js";
import { BillingSecretsResolver } from "../runtime/secrets-resolver.js";
import { channelPoster } from "../runtime/default.js";
import { dbBillingStore } from "../db/repositories/billing.js";
import { dbDeploymentStore } from "../db/repositories/deployments.js";
import { dbPlanPriceStore, dbPricingExperimentStore, dbWorkspacePlanStore } from "../db/repositories/plans.js";
import type { SessionLogger } from "../runtime/manager.js";
import { createBillingProvider } from "./factory.js";
import { BillingManager, type DeploymentLookup, type DemandSignalIngestor } from "./manager.js";
import { PlanBillingService } from "./plan-service.js";
import { billingStatus, type BillingStatus } from "./mode.js";

/**
 * Build the production billing surface (#98 + #125). The provider defaults to the no-network `none`
 * backend (`BILLING_PROVIDER=stripe` switches to the real adapter, loaded lazily). Secrets are resolved
 * per tenant via the #25 path; the channel post + persistence reuse the shared primitives. The #125
 * {@link PlanBillingService} (catalog + workspace-scoped checkout) shares the same provider + secrets and
 * is wired into the manager as the `planActivator` so a `plan_checkout` webhook activates the plan.
 */
export function createDefaultBilling(
  logger: SessionLogger,
  demandIngestor?: DemandSignalIngestor,
): {
  billingManager: BillingManager;
  planService: PlanBillingService;
  /** #481 go-live snapshot (provider + declared mode + whether real money is on) for the status route. */
  status: BillingStatus;
} {
  const env = loadEnv();
  const provider = createBillingProvider(env.billing);
  const status = billingStatus(env.billing.provider, env.billing.mode);
  // #98: billing reads STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET straight from env via a billing-only
  // resolver — NOT the agent-facing AGENT_SECRET_KEYS passthrough, which would inject the live key into
  // every agent session's runtime (the session manager uses EnvSecretsResolver as its inner resolver).
  const secrets = new BillingSecretsResolver();
  const deployments: DeploymentLookup = {
    latestForSession: (sessionId, channelId) =>
      dbDeploymentStore.latestForSession(sessionId, channelId),
  };
  const planService = new PlanBillingService({
    provider,
    prices: dbPlanPriceStore,
    plans: dbWorkspacePlanStore,
    pricingExperiments: dbPricingExperimentStore,
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
    // #101: a `demand_smoke` checkout webhook becomes the apex external willingness-to-pay signal.
    demandIngestor,
    toleranceSec: env.billing.webhookToleranceSeconds,
    logger,
  });
  return { billingManager, planService, status };
}

/** Back-compat helper: just the BillingManager (consumed by the founder console #104). */
export function createDefaultBillingManager(logger: SessionLogger): BillingManager {
  return createDefaultBilling(logger).billingManager;
}
