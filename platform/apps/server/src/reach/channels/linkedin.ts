import { normalizeRecipient } from "../../acquisition/compliance.js";
import type { ChannelSendContext, ReachChannelAdapter } from "../channel.js";
import type { ReachMessage, ReachSendOutcome } from "../types.js";

/**
 * The LinkedIn channel (#280 step 5) — wired in PARALLEL to email, same interface, but with a hard rule:
 * it sends ONLY through an official/permitted LinkedIn API ({@link LinkedInSender}). It NEVER drives the
 * LinkedIn UI and NEVER automates a logged-in session (that risks account bans and violates LinkedIn's
 * terms). When no permitted send path is configured it returns `status:"queued"` — the message is held for
 * a human/later, NEVER faked as sent. This keeps the channel honest: a queued count is visibly not a sent
 * count on the founder console.
 */

/** A permitted LinkedIn send seam (e.g. the Messaging API under an approved partnership). */
export interface LinkedInSender {
  readonly kind: string;
  send(input: { to: string; body: string }): Promise<{ externalId: string }>;
}

export interface LinkedInChannelDeps {
  /** A permitted-API sender. ABSENT (the default) ⇒ no permitted path ⇒ messages QUEUE, never send. */
  sender?: LinkedInSender;
  /** Optional tenant-scoped sender resolver. Returning undefined preserves queue-only behavior. */
  resolveSender?: (
    ctx: ChannelSendContext,
  ) => Promise<LinkedInSender | undefined> | LinkedInSender | undefined;
}

export function createLinkedInChannel(deps: LinkedInChannelDeps = {}): ReachChannelAdapter {
  return {
    channel: "linkedin",
    async send(message: ReachMessage, ctx: ChannelSendContext): Promise<ReachSendOutcome> {
      const to = message.toAddress.trim();
      if (!to) {
        return { status: "skipped", channel: "linkedin", externalId: null, detail: "no LinkedIn handle" };
      }
      if (ctx.suppressed.has(normalizeRecipient(to))) {
        return { status: "suppressed", channel: "linkedin", externalId: null, detail: "recipient on opt-out list" };
      }
      const sender = deps.sender ?? (await deps.resolveSender?.(ctx));
      if (!sender) {
        // No permitted API → QUEUE. We never UI-automate and never pretend it was sent.
        return {
          status: "queued",
          channel: "linkedin",
          externalId: null,
          detail: "no permitted LinkedIn send path configured — queued (never UI-automated)",
        };
      }
      try {
        const { externalId } = await sender.send({ to, body: message.body });
        return { status: "sent", channel: "linkedin", externalId, detail: `sent via ${sender.kind}` };
      } catch (err) {
        return {
          status: "failed",
          channel: "linkedin",
          externalId: null,
          detail: `send failed: ${err instanceof Error ? err.message : "unknown error"}`,
        };
      }
    },
  };
}
