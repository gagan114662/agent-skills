/**
 * Concrete action executors (issue #13). These touch the DB / realtime, so they live apart from the
 * pure `executor.ts` (which the unit job imports). `chat.post_message` is a real side effect — it
 * reuses #4 `postMessage` + #5 realtime and runs **as the requester**, re-checking the requester's
 * #9 capability at execution time (ADR-0013 §3). `external.send` is recorded-only — no real network
 * egress, so CI/tests never make outbound calls (ADR-0013 §2).
 */
import { effectiveCapability, satisfies } from "../auth/access.js";
import { getChannel, isChannelMember } from "../db/repositories/channels.js";
import { getCapability } from "../db/repositories/permissions.js";
import { postMessage } from "../db/repositories/messages.js";
import { publishMessageEvent } from "../realtime/bus.js";
import {
  buildRegistry,
  validateBillingRefund,
  validateChatPostMessage,
  validateExternalSend,
  type ActionExecutor,
  type ExecutorContext,
  type ExecutorRegistry,
} from "./executor.js";

/** Thrown by an executor when the action can't run; the route records the request as `failed`. */
export class ActionExecutionError extends Error {}

/**
 * Post a message to a channel as the requester. Re-validates that the channel is in the requester's
 * workspace and that the requester still holds `write` on it (ADR-0013 §3): an approval authorises
 * the human decision, never a capability bypass. Mirrors the #4 message route's publish-on-write.
 */
const chatPostMessage: ActionExecutor = {
  actionType: "chat.post_message",
  validate: validateChatPostMessage,
  summarize: (p) => `post to channel ${String(p.channelId)}: ${String(p.body).slice(0, 80)}`,
  async execute(payload, ctx: ExecutorContext): Promise<Record<string, unknown>> {
    const channelId = String(payload.channelId);
    const body = String(payload.body);

    const channel = await getChannel(channelId);
    if (!channel || channel.workspaceId !== ctx.workspaceId) {
      throw new ActionExecutionError("channel not found in this workspace");
    }
    const isMember = await isChannelMember(channelId, ctx.requesterMemberId);
    const explicit = await getCapability(ctx.workspaceId, ctx.requesterMemberId, "channel", channelId);
    const effective = effectiveCapability(explicit, isMember);
    if (!effective || !satisfies(effective, "write")) {
      throw new ActionExecutionError("requester lacks write capability on the channel");
    }

    const message = await postMessage({
      workspaceId: ctx.workspaceId,
      channelId,
      authorMemberId: ctx.requesterMemberId,
      body,
    });
    // Best-effort realtime fan-out, exactly like the REST message route (#5); never fails the write.
    publishMessageEvent(channelId, message).catch((err) =>
      ctx.log.error({ err }, "approval: message publish failed"),
    );
    return { messageId: message.id, channelId };
  },
};

/**
 * Represent an outbound "external send". Recorded-only: it performs **no** network egress (so tests
 * and CI never reach out), it just confirms the gated action would have been sent. ADR-0013 §2.
 */
const externalSend: ActionExecutor = {
  actionType: "external.send",
  validate: validateExternalSend,
  summarize: (p) =>
    `external send${p.target ? ` to ${String(p.target)}` : ""}: ${String(p.summary).slice(0, 80)}`,
  async execute(payload): Promise<Record<string, unknown>> {
    return {
      recorded: true,
      target: typeof payload.target === "string" ? payload.target : null,
      summary: String(payload.summary),
    };
  },
};

/**
 * Outbound money — a refund (#98, ADR-0043). It is **sensitive by default** (so it always pauses for a
 * human) and, even after approval, **recorded-only** in v1: it performs **no** Stripe call (no autonomous
 * money movement). Payouts/transfers stay manual in the Stripe dashboard. Wiring a real
 * `stripe.refunds.create` behind this gate is a deliberate future ADR — never an autonomous call.
 */
const billingRefund: ActionExecutor = {
  actionType: "billing.refund",
  validate: validateBillingRefund,
  summarize: (p) =>
    `refund ${typeof p.amountCents === "number" ? `${(p.amountCents / 100).toFixed(2)} of ` : ""}` +
    `payment ${String(p.paymentIntentId)}${p.reason ? ` (${String(p.reason)})` : ""}`,
  execute(payload): Promise<Record<string, unknown>> {
    // v1: record the approved intent, do NOT call Stripe. The owner executes the refund manually.
    return Promise.resolve({
      recorded: true,
      executed: false,
      paymentIntentId: typeof payload.paymentIntentId === "string" ? payload.paymentIntentId : null,
      amountCents: typeof payload.amountCents === "number" ? payload.amountCents : null,
      reason: typeof payload.reason === "string" ? payload.reason : null,
    });
  },
};

/** The executors wired for this deployment (ADR-0013 §2, #98). */
export const defaultRegistry: ExecutorRegistry = buildRegistry([
  chatPostMessage,
  externalSend,
  billingRefund,
]);
