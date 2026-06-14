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
import { recordViolation } from "../db/repositories/egress.js";
import { publishMessageEvent } from "../realtime/bus.js";
import { loadConfig } from "../config/loader.js";
import { decideEgress, resolveEgressPolicy } from "../runtime/egress-allowlist.js";
import {
  ActionExecutionError,
  buildRegistry,
  validateBillingRefund,
  validateBrowserAction,
  validateChatPostMessage,
  validateExternalSend,
  validateFinanceDisbursement,
  type ActionExecutor,
  type ExecutorContext,
  type ExecutorRegistry,
} from "./executor.js";
import { ventureWeeklyPlanExecutor } from "../venture-memory/executor.js";
import type { AcquisitionDispatcher } from "../acquisition/execution.js";
import { FINANCE_DISBURSEMENT_ACTION } from "./policy.js";

/** Re-exported from the pure `executor.ts` (kept here for backward-compatible imports). */
export { ActionExecutionError };

/**
 * Egress enforcement seam (#151, ADR-0151). The #13 gate already decides *whether* an outbound action
 * runs; this decides *where* it may go. `enforce` returns null when the target is allowed, or an error
 * message when it is denied/flagged — having already recorded the violation to the audit trail. Injected
 * so the registry is testable without a DB; the production default consults the #58 config + the repo.
 */
export interface EgressEnforcer {
  enforce(input: {
    workspaceId: string;
    target: string;
    actorMemberId: string;
  }): Promise<string | null>;
}

/** Production enforcer: per-tenant allowlist from #58 config; denied/flagged targets recorded + blocked. */
export const defaultEgressEnforcer: EgressEnforcer = {
  async enforce(input) {
    const policy = resolveEgressPolicy(loadConfig(input.workspaceId).egress);
    if (!policy.enabled) return null; // default-OFF: unrestricted egress, today's behavior.
    const decision = decideEgress({
      target: input.target,
      allowlist: policy.allowlist,
      enabled: true,
    });
    if (decision.decision === "allow") return null;
    await recordViolation({
      workspaceId: input.workspaceId,
      target: input.target,
      domain: decision.domain,
      reason: decision.reason ?? "egress blocked",
      actorMemberId: input.actorMemberId,
      detail: { decision: decision.decision, source: "external.send" },
    });
    return `egress blocked: ${decision.reason ?? "domain not allowed"}`;
  },
};

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
 * Represent an outbound "external send". Recorded-only **by default**: it performs no network egress
 * (so tests and CI never reach out), it just confirms the gated action would have been sent (ADR-0013
 * §2). #189 (ADR-0189) makes this the place a REAL ads/email/social/SEO campaign actually leaves the
 * building: an optional {@link AcquisitionDispatcher} is consulted AFTER the egress check. The
 * dispatcher returns a real send result when the channel is cleared to execute (master + channel flag
 * on AND the owner connected the provider), or `null` to fall back to recorded-only. With no dispatcher
 * injected — and with the acquisition flag off, which makes the dispatcher always return `null` — this
 * is byte-for-byte today's recorded-only behavior.
 *
 * #151: when the payload names a `target` and the workspace has an egress allowlist enabled, the target's
 * domain is checked here — the one application chokepoint for outbound sends. A blocked target records a
 * violation to the audit trail and fails the action (the #13 trail already recorded the human decision;
 * the egress trail records where it was refused). With the allowlist off (default), this is a no-op.
 */
function makeExternalSend(
  egress: EgressEnforcer,
  dispatcher?: AcquisitionDispatcher,
): ActionExecutor {
  return {
    actionType: "external.send",
    validate: validateExternalSend,
    summarize: (p) =>
      `external send${p.target ? ` to ${String(p.target)}` : ""}: ${String(p.summary).slice(0, 80)}`,
    async execute(payload, ctx: ExecutorContext): Promise<Record<string, unknown>> {
      const target = typeof payload.target === "string" ? payload.target : null;
      if (target) {
        const blocked = await egress.enforce({
          workspaceId: ctx.workspaceId,
          target,
          actorMemberId: ctx.requesterMemberId,
        });
        if (blocked) throw new ActionExecutionError(blocked);
      }
      // #189: hand the approved send to the acquisition dispatcher. A non-null result means a real
      // (or dry-run) campaign action ran; null means this is not an acquisition send, or the channel is
      // not cleared to execute → fall back to recorded-only (the default, no-egress behavior).
      if (dispatcher) {
        const dispatched = await dispatcher.dispatch(payload, {
          workspaceId: ctx.workspaceId,
          requesterMemberId: ctx.requesterMemberId,
        });
        if (dispatched) return dispatched;
      }
      return { recorded: true, target, summary: String(payload.summary) };
    },
  };
}

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

/**
 * Approve a side-effectful agent-browser action (#174, ADR-0174). **Recorded-only**: approving it does
 * NOT drive the browser (the live page lives in the agent's session process, not here at approval time).
 * It records the human's decision on the #13 audit trail; the agent's session re-checks for this
 * approval and re-runs the step in-session (the same re-check-at-execution model as ADR-0013 §3). This
 * keeps a browser mutation from ever being autonomous while keeping the live action in the session.
 */
const browserAction: ActionExecutor = {
  actionType: "browser.action",
  validate: validateBrowserAction,
  summarize: (p) => `browser ${String(p.tool)}${p.target ? ` on ${String(p.target)}` : ""}: ${String(p.summary).slice(0, 80)}`,
  execute(payload): Promise<Record<string, unknown>> {
    return Promise.resolve({
      recorded: true,
      executed: false, // the step re-runs in the agent's session once this approval exists.
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : null,
      tool: typeof payload.tool === "string" ? payload.tool : null,
      target: typeof payload.target === "string" ? payload.target : null,
    });
  },
};

/**
 * Outbound money — a finance disbursement (#194, ADR-0194). Like `billing.refund` it is **sensitive by
 * default** (always pauses for a human) and **recorded-only**: it performs **no** money movement
 * (`{recorded:true, executed:false}`). The owner disburses the funds by hand. Wiring a real transfer
 * behind this gate is a deliberate future ADR — never an autonomous call (money is irreversible).
 */
const financeDisbursement: ActionExecutor = {
  actionType: FINANCE_DISBURSEMENT_ACTION,
  validate: validateFinanceDisbursement,
  summarize: (p) =>
    (
      `disburse ${typeof p.amountCents === "number" ? `${(p.amountCents / 100).toFixed(2)} ` : ""}` +
      `for ${String(p.purpose)}`
    ).slice(0, 120),
  execute(payload): Promise<Record<string, unknown>> {
    return Promise.resolve({
      recorded: true,
      executed: false,
      amountCents: typeof payload.amountCents === "number" ? payload.amountCents : null,
      currency: typeof payload.currency === "string" ? payload.currency : "usd",
      purpose: typeof payload.purpose === "string" ? payload.purpose : null,
    });
  },
};

/**
 * Build the executor registry with an injectable egress enforcer (#151) and an optional acquisition
 * dispatcher (#189). With no dispatcher (the default) the `external.send` executor is recorded-only,
 * exactly as before — every existing approval test is untouched.
 */
export function buildDefaultRegistry(
  egress: EgressEnforcer = defaultEgressEnforcer,
  dispatcher?: AcquisitionDispatcher,
): ExecutorRegistry {
  return buildRegistry([
    chatPostMessage,
    makeExternalSend(egress, dispatcher),
    billingRefund,
    browserAction,
    ventureWeeklyPlanExecutor,
    financeDisbursement,
  ]);
}

/** The executors wired for this deployment (ADR-0013 §2, #98, #151). */
export const defaultRegistry: ExecutorRegistry = buildDefaultRegistry();
