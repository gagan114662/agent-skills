import type { AcquisitionConfig } from "../config/schema.js";
import type { AcquisitionChannel } from "./decide.js";

/**
 * Resolve the acquisition-execution policy from the layered config (#58, #189) with hard defaults —
 * mirrors `onboarding/caps.ts`. **Everything defaults OFF**: a deployment that sets no `acquisition`
 * block keeps today's behavior exactly — the `external.send` executor stays recorded-only (no network
 * egress). `enabled` is the master switch for the real-send dispatcher; the per-channel flags gate
 * each channel's real execution independently; `autoSend` is the separate, stricter switch for sending
 * without a human #13 yes (within the `*WindowCap` pre-commitment bounds). The footer fields back the
 * CAN-SPAM/GDPR enforcement; the `*Provider` kinds default to `dryrun` (recorded-only, no network).
 */
export interface AcquisitionCaps {
  enabled: boolean;
  channels: Record<AcquisitionChannel, boolean>;
  autoSend: boolean;
  ownerWorkspaceId: string | null;
  emailWindowCap: number;
  socialWindowCap: number;
  maxRetries: number;
  adsProvider: string;
  espProvider: string;
  socialProvider: string;
  brandName: string | null;
  postalAddress: string | null;
  unsubscribeUrl: string | null;
}

export const ACQUISITION_DEFAULTS: AcquisitionCaps = {
  enabled: false,
  channels: { ads: false, email: false, social: false, seo: false },
  autoSend: false,
  ownerWorkspaceId: null,
  emailWindowCap: 500,
  socialWindowCap: 50,
  maxRetries: 3,
  adsProvider: "dryrun",
  espProvider: "dryrun",
  socialProvider: "dryrun",
  brandName: null,
  postalAddress: null,
  unsubscribeUrl: null,
};

export function resolveAcquisitionCaps(cfg: AcquisitionConfig | undefined): AcquisitionCaps {
  const d = ACQUISITION_DEFAULTS;
  return {
    enabled: cfg?.enabled ?? d.enabled,
    channels: {
      ads: cfg?.ads ?? d.channels.ads,
      email: cfg?.email ?? d.channels.email,
      social: cfg?.social ?? d.channels.social,
      seo: cfg?.seo ?? d.channels.seo,
    },
    autoSend: cfg?.autoSend ?? d.autoSend,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? d.ownerWorkspaceId,
    emailWindowCap: cfg?.emailWindowCap ?? d.emailWindowCap,
    socialWindowCap: cfg?.socialWindowCap ?? d.socialWindowCap,
    maxRetries: cfg?.maxRetries ?? d.maxRetries,
    adsProvider: cfg?.adsProvider ?? d.adsProvider,
    espProvider: cfg?.espProvider ?? d.espProvider,
    socialProvider: cfg?.socialProvider ?? d.socialProvider,
    brandName: cfg?.brandName ?? d.brandName,
    postalAddress: cfg?.postalAddress ?? d.postalAddress,
    unsubscribeUrl: cfg?.unsubscribeUrl ?? d.unsubscribeUrl,
  };
}

/** Is a given channel cleared to execute REAL sends? (master flag AND the channel's own flag). */
export function channelExecutes(caps: AcquisitionCaps, channel: AcquisitionChannel): boolean {
  return caps.enabled && caps.channels[channel];
}

/** Is this workspace the owner's own (the owner-workspace-first rollout for auto-send)? */
export function isOwnerWorkspace(caps: AcquisitionCaps, workspaceId: string): boolean {
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}
