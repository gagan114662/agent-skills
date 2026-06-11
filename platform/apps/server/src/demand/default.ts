import {
  DemandValidationService,
  type CheckoutMinter,
  type LandingDeployer,
  type Refunder,
} from "./service.js";
import { dbExperimentStore, dbSignalStore, dbRefundStore } from "../db/repositories/demand.js";
import { getIdea } from "../db/repositories/venture.js";
import { getControls } from "../db/repositories/autonomy.js";
import type { SessionLogger } from "../runtime/manager.js";

/**
 * Production wiring for Demand Validation Rails (#101). The stores are the real #101 repository; the
 * **outbound** fake-door deploy + checkout-mint + provider-refund are **deterministic stand-ins** (mirroring
 * the #96 venture stubs and the #73 `DryRunDeployProvider`), so dev/CI/demo run at zero cloud spend and zero
 * money movement. The *inbound* composition is fully real: a signed #98 `demand_smoke` checkout webhook
 * reaches `ingestCheckout` (the apex external signal) via the BillingManager's `demandIngestor` seam.
 *
 * Deferred follow-ups (called out honestly): the landing deploy via a live #73 deploy of a generated page,
 * a real workspace-scoped #98 payment-link mint carrying `metadata.kind = "demand_smoke"`, and the actual
 * provider refund (a #13-gated, recorded-only outbound action — the `demand_refunds` audit row is already
 * the durable record).
 */

/** Stand-in fake-door deployer: a deterministic dry-run URL (the live #73 deploy is the follow-up). */
const dryRunDeployer: LandingDeployer = {
  deploy: async ({ experimentId }) => ({
    url: `https://demand-${experimentId}.dryrun.reload.app`,
  }),
};

/**
 * Stand-in checkout minter: a deterministic checkout URL. In production this composes a #98 workspace-
 * scoped payment link minted with `metadata.kind = "demand_smoke"` + the experiment id, so the strangers'
 * checkout flows back through the signature-verified webhook as a `paid` signal.
 */
const dryRunCheckout: CheckoutMinter = {
  mint: async ({ experimentId }) => ({
    url: `https://pay.dryrun.reload.app/demand-${experimentId}`,
  }),
};

/** Stand-in refunder: the durable record is the `demand_refunds` audit row; the provider refund (a #13- */
/* gated, recorded-only outbound action) is the deferred follow-up. */
function loggingRefunder(logger?: SessionLogger): Refunder {
  return {
    refund: async (input) => {
      logger?.info(
        { workspaceId: input.workspaceId, externalRef: input.externalRef },
        "demand: pre-availability charge flagged for auto-refund (recorded in demand_refunds)",
      );
    },
  };
}

/** Build the production DemandValidationService over the real repository + the documented stand-ins. */
export function createDefaultDemandService(
  logger?: SessionLogger,
  now?: () => Date,
): DemandValidationService {
  return new DemandValidationService({
    experiments: dbExperimentStore,
    signals: dbSignalStore,
    refunds: dbRefundStore,
    deployer: dryRunDeployer,
    checkout: dryRunCheckout,
    refunder: loggingRefunder(logger),
    // #19 IDOR: an experiment may only attach to a venture idea in the same workspace.
    ventures: { exists: async (wid, ideaId) => (await getIdea(wid, ideaId)) !== undefined },
    // #17: launching a new fake-door is gated by the same kill switch as an autonomy launch.
    killSwitch: async (wid) => (await getControls(wid)).killSwitch,
    now,
  });
}
