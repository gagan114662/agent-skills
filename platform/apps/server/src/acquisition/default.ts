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
 * ONE real adapter is wired here (issue #395): the email channel's ESP is the real Postmark provider,
 * behind the connect-once gate. It stays SAFE BY DEFAULT — `resolvePostmarkForWorkspace` returns
 * `live:false` (→ the recorded-only dry-run sender, no network) unless the owner has (a) selected the
 * Postmark ESP for the workspace, (b) connected the channel (the ledger shows `connected` with a verified
 * From address), AND (c) set the owner-gated `POSTMARK_SERVER_TOKEN` secret. ads/social/SEO stay dry-run.
 * A real send is NEVER autonomous: the dispatcher is only reached from `executeApprovedRequest`, i.e. after
 * a human approves the parked `external.send` #13 request.
 */

import { loadConfig } from "../config/loader.js";
import { defaultEgressEnforcer, buildDefaultRegistry } from "../approvals/runtime.js";
import { defaultComplianceEnforcer } from "../legal/enforcer.js";
import type { ExecutorRegistry } from "../approvals/executor.js";
import { resolveAcquisitionCaps, type AcquisitionCaps } from "./caps.js";
import { createAcquisitionProviders } from "./providers.js";
import { createPostmarkEspProvider, type PostmarkEspResolution } from "./postmark-esp.js";
import { getChannelConnection } from "../db/repositories/outbound-channels.js";
import { getChannelDescriptor, LOWEST_RISK_CHANNEL } from "../outbound-channel/channel.js";
import { verifyAndRecordSend } from "../outbound-channel/service.js";
import { createAcquisitionDispatcher, type AcquisitionDispatcher } from "./execution.js";
import { buildDeliveryDispatcher } from "../delivery/default.js";
import { buildHostedPublishDispatcher } from "../hosted/default.js";
import type { VerificationEngine } from "../verification/engine.js";
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

/**
 * Resolve, per workspace and at send time, whether a REAL Postmark send is connected (and from where).
 * Returns `live:false` — the recorded-only dry-run sender, no network — unless ALL three owner-gated
 * conditions hold: the workspace selected the Postmark ESP, the connect-once ledger shows `connected` with
 * a verified From address, and the `POSTMARK_SERVER_TOKEN` secret is set. The token is read inline and
 * never persisted here (mirrors `outbound-channel/service.ts`); only its presence is consulted.
 */
async function resolvePostmarkForWorkspace(workspaceId: string): Promise<PostmarkEspResolution> {
  const caps = acquisitionCapsFor(workspaceId);
  if (caps.espProvider !== "postmark") return { live: false, serverToken: "", from: "" };
  const connection = await getChannelConnection(workspaceId, LOWEST_RISK_CHANNEL);
  const connected = connection?.status === "connected";
  const from = (connection?.fromAddress ?? "").trim();
  const credentialEnvKey = getChannelDescriptor(LOWEST_RISK_CHANNEL)?.credentialEnvKey ?? "POSTMARK_SERVER_TOKEN";
  const serverToken = (process.env[credentialEnvKey] ?? "").trim();
  return { live: connected && from !== "" && serverToken !== "", serverToken, from };
}

/**
 * Build the production acquisition dispatcher over the real repos + providers. The email ESP is the real,
 * connect-once-gated Postmark provider (#395); ads/social/SEO stay dry-run (recorded-only). Default-safe:
 * with nothing connected the Postmark provider resolves to the dry-run sender, so behavior is unchanged.
 */
export function buildAcquisitionDispatcher(): AcquisitionDispatcher {
  return createAcquisitionDispatcher({
    resolveCaps: acquisitionCapsFor,
    providers: createAcquisitionProviders(
      {},
      { esp: createPostmarkEspProvider({ resolve: resolvePostmarkForWorkspace }) },
    ),
    envelopes: dbEnvelopeStore,
    suppressions: dbSuppressionStore,
    receipts: dbReceiptStore,
    outboundReadbacks: {
      async recordPostmarkReadbacks(input) {
        await Promise.all(
          input.messageIds.map((messageId, index) =>
            verifyAndRecordSend({
              workspaceId: input.workspaceId,
              channel: LOWEST_RISK_CHANNEL,
              recipient: input.recipients[index] ?? input.recipients[0] ?? "",
              approvalRequestId: input.approvalRequestId,
              probe: async () => ({
                messageId,
                observedAt: new Date().toISOString(),
                detail: {
                  provider: input.provider,
                  ...input.detail,
                },
              }),
            }),
          ),
        );
      },
    },
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
export function buildAcquisitionRegistry(verification?: VerificationEngine): ExecutorRegistry {
  return buildDefaultRegistry(
    defaultEgressEnforcer,
    defaultComplianceEnforcer,
    buildAcquisitionDispatcher(),
    buildDeliveryDispatcher(verification),
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
