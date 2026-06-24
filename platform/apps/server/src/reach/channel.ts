import type { FooterInfo } from "../acquisition/compliance.js";
import type { ReachChannel, ReachMessage, ReachSendOutcome } from "./types.js";

/**
 * The Channel seam (#280 step 5) — the channel-agnostic interface every send channel implements. Email is
 * the live auto-send channel (CAN-SPAM/GDPR enforced in code, working unsubscribe). LinkedIn implements
 * the same interface but sends ONLY through an official/permitted API; with no permitted send path it
 * QUEUES (returns `status:"queued"`) — it NEVER UI-automates and NEVER fakes a send.
 *
 * Every channel honours the same rails passed in {@link ChannelSendContext}: the opt-out/suppression set
 * and the compliance footer facts. The per-domain rate cap is enforced by the service BEFORE a channel is
 * called (it is channel-agnostic), so an adapter only sees messages already within the cap.
 */

export interface ChannelSendContext {
  /** Workspace that owns this outbound attempt; used only by adapters that resolve tenant-scoped providers. */
  workspaceId: string;
  /** Normalised opt-out/suppression set (addresses that bounced, complained, or unsubscribed). */
  suppressed: ReadonlySet<string>;
  /** CAN-SPAM/GDPR footer facts (brand, postal address, unsubscribe). Incomplete ⇒ email cannot send. */
  footerInfo: Partial<FooterInfo> | undefined;
}

export interface ReachChannelAdapter {
  readonly channel: ReachChannel;
  /** Attempt to send one message. Returns an OUTCOME (never throws for an expected block — suppressed/queued/skipped). */
  send(message: ReachMessage, ctx: ChannelSendContext): Promise<ReachSendOutcome>;
}
