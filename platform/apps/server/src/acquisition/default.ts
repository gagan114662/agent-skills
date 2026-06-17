/**
 * Acquisition execution — production wiring (issue #189, ADR-0189).
 *
 * Binds the pure dispatcher to the real repos, providers, and layered config, and exposes two things to
 * the app:
 *   - {@link buildAcquisitionRegistry} — the #13 executor registry whose `external.send` executor routes
 *     through the acquisition dispatcher. It is safe to wire unconditionally: with the acquisition flag
 *     off (the default), the dispatcher returns `null` for every send and the executor stays
 *     recorded-only — byte-for-byte today's behavior.
 *   - {@link buildAcquisitionBriefReader} — the founder-brief reader (AC5) that turns the external send
 *     receipts into the daily-brief acquisition section (spend + CAC + failing channels).
 *
 * No real ESP/ads/social adapters are wired here — every provider resolves to its dry-run (recorded-only)
 * default. Connecting a real provider is a deliberate future step behind the #192 credential vault.
 */

import { loadConfig } from "../config/loader.js";
import { defaultEgressEnforcer, buildDefaultRegistry } from "../approvals/runtime.js";
import { defaultComplianceEnforcer } from "../legal/enforcer.js";
import type { ExecutorRegistry } from "../approvals/executor.js";
import { resolveAcquisitionCaps, type AcquisitionCaps } from "./caps.js";
import { createAcquisitionProviders } from "./providers.js";
import { createAcquisitionDispatcher, type AcquisitionDispatcher } from "./execution.js";
import { buildDeliveryDispatcher } from "../delivery/default.js";
import { buildHostedPublishDispatcher } from "../hosted/default.js";
import { buildAcquisitionBriefView, type AcquisitionBriefView } from "./cac.js";
import type { FooterInfo } from "./compliance.js";
import {
  dbEnvelopeStore,
  dbReceiptStore,
  dbSuppressionStore,
  emailWarmupState,
  spendByChannelSince,
  conversionsByChannelSince,
  failingChannelsSince,
} from "../db/repositories/acquisition.js";

/** Resolve the acquisition caps for a workspace from the layered config (#58). */
export function acquisitionCapsFor(workspaceId: string): AcquisitionCaps {
  return resolveAcquisitionCaps(loadConfig(workspaceId).acquisition);
}

/** The CAN-SPAM/GDPR footer facts for a workspace, or null when the owner hasn't supplied them. */
function footerInfoFor(workspaceId: string): FooterInfo | null {
  const caps = acquisitionCapsFor(workspaceId);
  if (!caps.brandName || !caps.postalAddress || !caps.unsubscribeUrl) return null;
  return {
    brandName: caps.brandName,
    postalAddress: caps.postalAddress,
    unsubscribeUrl: caps.unsubscribeUrl,
  };
}

/** Build the production acquisition dispatcher over the real repos + dry-run providers. */
export function buildAcquisitionDispatcher(): AcquisitionDispatcher {
  return createAcquisitionDispatcher({
    resolveCaps: acquisitionCapsFor,
    providers: createAcquisitionProviders({}),
    envelopes: dbEnvelopeStore,
    suppressions: dbSuppressionStore,
    receipts: dbReceiptStore,
    emailWindow: {
      warmupState: (workspaceId) => emailWarmupState(workspaceId, Date.now()),
    },
    footerInfo: footerInfoFor,
  });
}

/**
 * The #13 executor registry with the acquisition dispatcher wired into `external.send` (#189) AND the
 * delivery dispatcher wired into `agent.deliverable` (#295). Safe to use everywhere the default registry
 * was used — both are default-OFF: with the acquisition flag off the `external.send` executor stays
 * recorded-only, and with the delivery flag off the `agent.deliverable` executor stays a pure
 * acknowledgement.
 */
export function buildAcquisitionRegistry(): ExecutorRegistry {
  return buildDefaultRegistry(
    defaultEgressEnforcer,
    defaultComplianceEnforcer,
    buildAcquisitionDispatcher(),
    buildDeliveryDispatcher(),
    buildHostedPublishDispatcher(),
  );
}

/**
 * The founder-brief acquisition section (AC5): roll the external send receipts in a window into spend +
 * CAC + failing channels. External-grounded (premortem #200 §2) — spend/conversions are receipt rows.
 * Returns null when there is nothing to report (no spend, no conversions, no failures) so the brief
 * stays unchanged when the channel is idle.
 */
export async function buildAcquisitionBriefSection(
  workspaceId: string,
  windowMs: number = 24 * 60 * 60 * 1000,
): Promise<AcquisitionBriefView | null> {
  const since = new Date(Date.now() - windowMs);
  const [spend, conversions, failing] = await Promise.all([
    spendByChannelSince(workspaceId, since),
    conversionsByChannelSince(workspaceId, since),
    failingChannelsSince(workspaceId, since),
  ]);
  if (spend.length === 0 && conversions.length === 0 && failing.length === 0) return null;
  return buildAcquisitionBriefView(spend, conversions, failing);
}
