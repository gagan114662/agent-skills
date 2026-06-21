/**
 * The outbound-channel enablement flags (issue #395 §2). Pure — runs in the no-DB/no-network unit job.
 *
 * #395 requires a global master switch (`RELOAD_ACQUISITION_ENABLED`) AND a per-channel switch, BOTH OFF by
 * default. Those flags already exist as the `acquisition` config block (`acquisition.enabled` +
 * `acquisition.email`, defaulted off, owner-workspace-first via `acquisition.ownerWorkspaceId`). Rather than
 * add a parallel lever, this module reads that block and decides whether a given channel may send for a
 * given workspace. The flag NEVER sends on its own — a real send still requires the channel connected (a
 * recorded credential) AND an owner #13 approval (see `decideChannelSend`).
 */

import type { OutboundChannel } from "./channel.js";

/** The slice of resolved config this module reads — the existing `acquisition` block (#189/#395). */
export interface AcquisitionFlagsInput {
  /** `RELOAD_ACQUISITION_ENABLED` — the global master switch. Default OFF. */
  enabled?: boolean;
  /** `RELOAD_ACQUISITION_EMAIL` — the per-channel switch for the email lane. Default OFF. */
  email?: boolean;
  /** Roll the channel out to the owner's workspace first; when set, only that workspace is in scope. */
  ownerWorkspaceId?: string;
}

export interface OutboundChannelFlags {
  /** The global master switch (`acquisition.enabled`). */
  readonly globalEnabled: boolean;
  /** The per-channel switch for email (`acquisition.email`). */
  readonly emailEnabled: boolean;
  /** The owner's workspace id, if rollout is owner-workspace-first. */
  readonly ownerWorkspaceId: string | null;
}

/** Resolve the channel flags from the acquisition config block. Absent block ⇒ everything OFF. */
export function resolveOutboundChannelFlags(acquisition: AcquisitionFlagsInput | undefined): OutboundChannelFlags {
  return {
    globalEnabled: acquisition?.enabled === true,
    emailEnabled: acquisition?.email === true,
    ownerWorkspaceId:
      typeof acquisition?.ownerWorkspaceId === "string" && acquisition.ownerWorkspaceId.length > 0
        ? acquisition.ownerWorkspaceId
        : null,
  };
}

/** Is `workspaceId` in the owner-workspace-first rollout scope? (No owner pinned ⇒ every workspace is.) */
export function isWorkspaceInRolloutScope(flags: OutboundChannelFlags, workspaceId: string): boolean {
  return flags.ownerWorkspaceId === null || flags.ownerWorkspaceId === workspaceId;
}

/**
 * Do the flags permit `channel` to send for `workspaceId`? Requires the global master switch AND the
 * per-channel switch AND the rollout scope. This is necessary-but-not-sufficient: a real send still needs
 * a connected credential and an owner #13 approval. Default (no acquisition block) is OFF for every channel.
 */
export function isChannelFlagLive(
  flags: OutboundChannelFlags,
  channel: OutboundChannel,
  workspaceId: string,
): boolean {
  if (!flags.globalEnabled) return false;
  if (!isWorkspaceInRolloutScope(flags, workspaceId)) return false;
  switch (channel) {
    case "email_postmark":
      return flags.emailEnabled;
    default:
      return false;
  }
}
