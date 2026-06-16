/**
 * Deliverable delivery — production wiring (issue #295, ADR-0295).
 *
 * Binds the pure dispatcher to the real repos, providers, and layered config. It is safe to wire
 * unconditionally: with the delivery flag off (the default), {@link resolveDeliveryFlags} returns all-off,
 * the dispatcher's `ship` returns `null`, and the `agent.deliverable` executor stays a pure acknowledgement
 * — byte-for-byte today's behavior.
 *
 * No customer credentials/Stripe (a #295 hard constraint): the live-page provider is selected by the
 * deployment-level `delivery.publishProvider` (`github_pages` reuses the #231 server-token GitHub Pages
 * provider; default `dryrun` is non-reachable). Social/email ride the #189 dry-run providers — a real
 * X/LinkedIn or ESP adapter behind connected credentials is a deliberate future ADR.
 */

import { loadConfig } from "../config/loader.js";
import { getChannel } from "../db/repositories/channels.js";
import { dbDeliveryReceiptStore } from "../db/repositories/delivery.js";
import { dryRunSocialProvider, dryRunEspProvider } from "../acquisition/providers.js";
import { DryRunPublishProvider } from "../realworld/publish/dry-run-provider.js";
import { GitHubPagesPublishProvider } from "../realworld/publish/github-pages-provider.js";
import type { PublishProvider } from "../realworld/publish/provider.js";
import {
  departmentForDeliverableChannel,
  resolveDeliveryFlags,
  type DeliveryFlags,
} from "./decide.js";
import {
  EmailChannelAdapter,
  PublishChannelAdapter,
  SocialChannelAdapter,
} from "./adapters.js";
import { createDeliveryDispatcher, type DeliveryDispatcher } from "./dispatcher.js";

/** Resolve the ship flags for a workspace from the layered config (#58) — default-OFF, owner-first. */
export function deliveryFlagsFor(workspaceId: string): DeliveryFlags {
  return resolveDeliveryFlags(loadConfig(workspaceId).delivery, workspaceId);
}

/**
 * Resolve the STRUCTURAL department a deliverable belongs to from the channel it was drafted in. Tenant-
 * scoped (#3): a channel from another workspace resolves to `null` (not shippable). Never reads the draft
 * (injection defense, #200 §6).
 */
export async function resolveDeliveryDepartment(
  workspaceId: string,
  channelId: string | null,
): Promise<string | null> {
  if (!channelId) return null;
  const channel = await getChannel(channelId);
  if (!channel || channel.workspaceId !== workspaceId) return null;
  return departmentForDeliverableChannel(channel.name);
}

/**
 * The deployment-level live-page provider. `github_pages` reuses the #231 server-token provider (the token
 * is a single server credential, not per-tenant); anything else is the non-reachable dry-run provider. Read
 * from the managed/base config layer (workspace-agnostic), so a deployment opts into live publishing once.
 */
function resolvePublishProvider(): PublishProvider {
  const kind = loadConfig().delivery.publishProvider;
  return kind === "github_pages" ? new GitHubPagesPublishProvider() : new DryRunPublishProvider();
}

/** Build the production delivery dispatcher over the real repos + providers. */
export function buildDeliveryDispatcher(): DeliveryDispatcher {
  return createDeliveryDispatcher({
    resolveDepartment: resolveDeliveryDepartment,
    resolveFlags: deliveryFlagsFor,
    adapters: {
      publish: new PublishChannelAdapter(resolvePublishProvider()),
      social: new SocialChannelAdapter(dryRunSocialProvider),
      email: new EmailChannelAdapter(dryRunEspProvider),
    },
    receipts: dbDeliveryReceiptStore,
  });
}
