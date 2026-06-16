import {
  appendComplianceFooter,
  checkEmailCompliance,
  normalizeRecipient,
  type FooterInfo,
} from "../../acquisition/compliance.js";
import type { ChannelSendContext, ReachChannelAdapter } from "../channel.js";
import type { ReachMessage, ReachSendOutcome } from "../types.js";

/**
 * The email channel (#280 step 5) — the LIVE auto-send channel. Sending a marketing email is NOT a money
 * action, so it ships autonomously, but only through the in-code rails (premortem #200 §4, all reused
 * from #189): the recipient must not be on the opt-out/suppression list; the body must carry a complete
 * CAN-SPAM/GDPR footer with a WORKING, per-recipient unsubscribe link; and the per-domain rate cap (the
 * service's job, applied before this adapter is called) bounds the blast radius. With a `dryrun` sender
 * the send is recorded-only (no network egress) — the byte-for-byte default until an owner connects a
 * real ESP (#192 vault).
 */

/** The ESP send seam. A real ESP adapter (SendGrid/Postmark/SES) implements this behind the #192 vault. */
export interface EspSender {
  /** The sender kind, for the outcome detail (e.g. "dryrun", "sendgrid"). */
  readonly kind: string;
  send(input: { to: string; subject: string; body: string }): Promise<{ externalId: string }>;
}

/** FNV-1a → hex, for a deterministic per-recipient unsubscribe token (no PII in the token). */
function token(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The default recorded-only sender: deterministic id, NO network. The byte-for-byte default. */
export const dryRunEspSender: EspSender = {
  kind: "dryrun",
  async send(input) {
    return { externalId: `dryrun-email-${token(`${input.to}|${input.subject}`)}` };
  },
};

/** Append a per-recipient unsubscribe token so the footer link actually unsubscribes the right address. */
function footerForRecipient(
  footerInfo: Partial<FooterInfo> | undefined,
  recipient: string,
): Partial<FooterInfo> | undefined {
  if (!footerInfo?.unsubscribeUrl) return footerInfo;
  const sep = footerInfo.unsubscribeUrl.includes("?") ? "&" : "?";
  return { ...footerInfo, unsubscribeUrl: `${footerInfo.unsubscribeUrl}${sep}u=${token(recipient)}` };
}

export interface EmailChannelDeps {
  sender?: EspSender;
}

export function createEmailChannel(deps: EmailChannelDeps = {}): ReachChannelAdapter {
  const sender = deps.sender ?? dryRunEspSender;
  return {
    channel: "email",
    async send(message: ReachMessage, ctx: ChannelSendContext): Promise<ReachSendOutcome> {
      const to = normalizeRecipient(message.toAddress);
      if (!to) {
        return { status: "skipped", channel: "email", externalId: null, detail: "no email address" };
      }
      if (ctx.suppressed.has(to)) {
        return { status: "suppressed", channel: "email", externalId: null, detail: "recipient on opt-out list" };
      }

      const footerInfo = footerForRecipient(ctx.footerInfo, to);
      if (!footerInfo) {
        // No footer facts at all ⇒ a lawful email is impossible. Skip, never send.
        return { status: "skipped", channel: "email", externalId: null, detail: "missing CAN-SPAM footer info" };
      }
      const body = appendComplianceFooter(message.body, footerInfo as FooterInfo);
      const compliance = checkEmailCompliance({
        body,
        recipients: [to],
        suppressed: ctx.suppressed,
        footerInfo,
      });
      if (!compliance.ok) {
        // A compliance gap (no footer facts / no deliverable recipient) is a SKIP, never a silent send.
        return {
          status: compliance.allowedRecipients.length === 0 ? "suppressed" : "skipped",
          channel: "email",
          externalId: null,
          detail: compliance.violations.join("; ") || "compliance check failed",
        };
      }

      try {
        const { externalId } = await sender.send({ to, subject: message.subject, body });
        return {
          status: "sent",
          channel: "email",
          externalId,
          detail: sender.kind === "dryrun" ? "dry-run (recorded-only, no network)" : `sent via ${sender.kind}`,
        };
      } catch (err) {
        return {
          status: "failed",
          channel: "email",
          externalId: null,
          detail: `send failed: ${err instanceof Error ? err.message : "unknown error"}`,
        };
      }
    },
  };
}
