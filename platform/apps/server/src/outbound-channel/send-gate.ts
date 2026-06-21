/**
 * The structural always-gate for an outbound-channel send (issue #395, premortem #200 §3/§4). Pure — runs
 * in the no-DB/no-network unit job.
 *
 * A real send is irreversible (#200 §4: a sent email is in a stranger's inbox forever, and burns sender
 * reputation), so this decision NEVER returns `proceed:true` autonomously. All three conditions must hold:
 *   1. the channel's flags are live (the global + per-channel switches, default OFF), AND
 *   2. the channel is connected (the owner completed the connect-once step — a credential is recorded), AND
 *   3. an owner #13 approval id is present (the per-send human "yes").
 * There is no path that skips the #13 gate — `proceed` is false unless an approval id is supplied. (Spend,
 * where a channel ever spends money, is gated additionally by the #13 money path; email never spends.)
 */

import type { OutboundChannel, OutboundChannelStatus } from "./constants.js";

export type ChannelSendDecisionCode =
  | "proceed"
  | "flag_disabled"
  | "channel_not_connected"
  | "approval_required";

export interface ChannelSendDecision {
  /** True ONLY when the flags are live, the channel is connected, and an owner approval id is present. */
  readonly proceed: boolean;
  readonly code: ChannelSendDecisionCode;
  /** An owner-facing reason (no internal agent chatter). */
  readonly reason: string;
}

export interface ChannelSendInput {
  readonly channel: OutboundChannel;
  /** The ledger status for (workspace, channel); `null` = no connection row at all. */
  readonly connectionStatus: OutboundChannelStatus | null;
  /** Whether the enablement flags permit this channel to send for this workspace (see `isChannelFlagLive`). */
  readonly flagLive: boolean;
  /** The #13 approval that authorized THIS send. Absent/blank ⇒ the gate refuses to proceed. */
  readonly approvalRequestId?: string | null;
}

/** Decide whether an outbound send may proceed. See the module contract: all three conditions required. */
export function decideChannelSend(input: ChannelSendInput): ChannelSendDecision {
  if (!input.flagLive) {
    return {
      proceed: false,
      code: "flag_disabled",
      reason: `The ${input.channel} channel is not enabled. Turn on the acquisition flags before sending.`,
    };
  }
  if (input.connectionStatus !== "connected") {
    return {
      proceed: false,
      code: "channel_not_connected",
      reason: `The ${input.channel} channel is not connected. Connect it once before sending.`,
    };
  }
  const approvalId = (input.approvalRequestId ?? "").trim();
  if (approvalId === "") {
    return {
      proceed: false,
      code: "approval_required",
      reason: "This send needs an owner approval. It has been queued for a human to approve.",
    };
  }
  return { proceed: true, code: "proceed", reason: "Flags live, channel connected, send approved." };
}
