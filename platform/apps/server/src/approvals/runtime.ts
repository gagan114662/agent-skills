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
import { defaultComplianceEnforcer } from "../legal/enforcer.js";
import {
  ActionExecutionError,
  buildRegistry,
  validateAgentDeliverable,
  validateBillingRefund,
  validateBrowserAction,
  validateChatPostMessage,
  validateExternalSend,
  validateHostedPublish,
  validateFinanceDisbursement,
  validateMonetizationActivatePrice,
  validateMonetizationPayoutSettings,
  validateOutreachSend,
  validateReachDataCreditSpend,
  validateSkillOptAdoptEdit,
  validateConnectAccount,
  type ActionExecutor,
  type ExecutorContext,
  type ExecutorRegistry,
} from "./executor.js";
import { ventureWeeklyPlanExecutor } from "../venture-memory/executor.js";
import type { AcquisitionDispatcher } from "../acquisition/execution.js";
import type { DeliveryDispatcher } from "../delivery/dispatcher.js";
import type { HostedPublishDispatcher } from "../hosted/dispatcher.js";
import { buildHostedPublishDispatcher } from "../hosted/default.js";
import { markMessageSent } from "../db/repositories/outreach.js";
import {
  FINANCE_DISBURSEMENT_ACTION,
  MONETIZATION_ACTIVATE_PRICE_ACTION,
  MONETIZATION_PAYOUT_SETTINGS_ACTION,
  OUTREACH_SEND_ACTION,
  REACH_DATA_CREDIT_ACTION,
  SKILLOPT_ADOPT_EDIT_ACTION,
  CONNECTION_CONNECT_ACCOUNT_ACTION,
} from "./policy.js";

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

/**
 * Send-layer compliance enforcement seam (#196, ADR-0196). Where {@link EgressEnforcer} decides *where* a
 * send may go, this decides *whether it is lawful to send to this recipient* — CAN-SPAM unsubscribe +
 * postal footer, CASL/GDPR consent, and the suppression list — enforced **in code at the one chokepoint**,
 * not by agent goodwill. `enforce` returns null when the send is allowed, or a reason string when it is
 * blocked (having recorded the decision to the audit trail). Injected so the registry stays testable; the
 * production default (`legal/enforcer.ts`) is a no-op unless the tenant turned the pack on (default OFF),
 * so existing behavior + every approval test is byte-for-byte unchanged.
 */
export interface ComplianceEnforcer {
  enforce(input: {
    workspaceId: string;
    kind: string;
    target: string | null;
    actorMemberId: string;
    envelope?: Record<string, unknown>;
  }): Promise<string | null>;
}

/** The no-op default: allows everything. Replaced in production wiring by `legal/enforcer.ts`. */
export const noopComplianceEnforcer: ComplianceEnforcer = {
  enforce: () => Promise.resolve(null),
};

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
 * `agent.deliverable` (#248 + #295): a completed agent session's draft, surfaced for owner review in the
 * APPROVAL NEEDED queue so a briefed task never "vanishes" (its result lived only as a channel message
 * + `agent_sessions.result` row the owner never saw).
 *
 * **Without a delivery dispatcher (the default)** the executor is a pure ACKNOWLEDGEMENT — it performs NO
 * side effect: approving simply records the owner saw the draft. This is byte-for-byte today's behavior.
 *
 * **With a {@link DeliveryDispatcher} injected (#295, default-OFF behind a flag, owner-workspace-first)**
 * the OWNER's approval becomes the ship trigger: the dispatcher routes the draft to the right channel
 * adapter (a live published page / a social post / an email), records a production-grounded receipt tied
 * to THIS approval, and the result reports what shipped. The dispatcher returns `null` (→ fall back to the
 * pure acknowledgement) whenever delivery is off for the workspace, the department is not shippable, or
 * there is no approval id — so nothing ever ships without an explicit owner approval in the #13 queue.
 *
 * The approval (a human reviewing the draft on the card) IS the gate (premortem #200 §4: a public/
 * irreversible action is human-gated, never autonomous), and routing is structural (#200 §6: a poisoned
 * draft can never redirect the ship). Creates no new authority; the payload is data.
 */
function makeAgentDeliverable(delivery?: DeliveryDispatcher): ActionExecutor {
  return {
    actionType: "agent.deliverable",
    validate: validateAgentDeliverable,
    summarize: (p) => `deliverable ready for review (session ${String(p.sessionId).slice(0, 8)})`,
    async execute(payload, ctx: ExecutorContext): Promise<Record<string, unknown>> {
      const ack = { acknowledged: true, sessionId: String(payload.sessionId) };
      if (delivery) {
        const shipped = await delivery.ship(payload, {
          workspaceId: ctx.workspaceId,
          approvalRequestId: ctx.requestId ?? "",
        });
        if (shipped) return { ...ack, ...shipped };
      }
      return ack;
    },
  };
}

/**
 * `hosted.publish` (#266): take a customer's drafted blog article / landing page LIVE on their own domain
 * (zero repo, zero deploy). The OWNER's #13 approval IS the publish trigger — the hard constraint that
 * nothing goes live without owner approval. Without a {@link HostedPublishDispatcher} injected the executor
 * is a pure acknowledgement (no side effect). With one (the production default), approval ships the page:
 * the dispatcher re-renders the page bound to its canonical URL, flips it to `published`, and ties the live
 * URL back to THIS approval. The dispatcher returns `null` (→ pure ack) whenever hosting is OFF for the
 * workspace or the approval id is missing, so nothing ever publishes without an explicit owner approval.
 * Routing is structural — the page id comes off the approval payload, never the content (#200 §6).
 */
function makeHostedPublish(hosted?: HostedPublishDispatcher): ActionExecutor {
  return {
    actionType: "hosted.publish",
    validate: validateHostedPublish,
    summarize: (p) => `publish hosted page ${String(p.slug ?? p.pageId).slice(0, 60)}`,
    async execute(payload, ctx: ExecutorContext): Promise<Record<string, unknown>> {
      const ack = { acknowledged: true, pageId: String(payload.pageId) };
      if (hosted) {
        const shipped = await hosted.ship(payload, {
          workspaceId: ctx.workspaceId,
          approvalRequestId: ctx.requestId ?? "",
        });
        if (shipped) return { ...ack, ...shipped };
      }
      return ack;
    },
  };
}

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
  compliance: ComplianceEnforcer,
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
      // #196: send-layer CAN-SPAM/CASL/GDPR. Runs for every external.send (the no-op default allows all,
      // so behavior is unchanged until a tenant turns the legal pack on). The `kind` discriminates email
      // vs social vs publish; the `compliance` envelope on the payload carries the footer/consent basis.
      // Enforced BEFORE the acquisition dispatcher so a non-compliant send can never reach a real channel.
      const kind = typeof payload.kind === "string" ? payload.kind : "";
      const envelope =
        payload.compliance && typeof payload.compliance === "object"
          ? (payload.compliance as Record<string, unknown>)
          : undefined;
      const unlawful = await compliance.enforce({
        workspaceId: ctx.workspaceId,
        kind,
        target,
        actorMemberId: ctx.requesterMemberId,
        envelope,
      });
      if (unlawful) throw new ActionExecutionError(unlawful);
      // #189: hand the approved (and now compliance-cleared) send to the acquisition dispatcher. A non-null
      // result means a real (or dry-run) campaign action ran; null means this is not an acquisition send, or
      // the channel is not cleared to execute → fall back to recorded-only (the default, no-egress behavior).
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
 * Outbound money boundary — activating a venture's pricing (#188, ADR-0188). **Sensitive by default**
 * (always pauses for the owner) and **recorded-only**: approving records the owner's go on the #13 audit
 * trail; it performs NO money movement and mints NO link here. The monetization engine, seeing this
 * approval `executed`, then mints the REAL hosted payment link (inbound-only collection) using the
 * venture's OWN Stripe key — a live link is enabled only after the human go, never autonomously.
 */
const monetizationActivatePrice: ActionExecutor = {
  actionType: MONETIZATION_ACTIVATE_PRICE_ACTION,
  validate: validateMonetizationActivatePrice,
  summarize: (p) =>
    (
      `activate pricing for ${String(p.ventureName)}: ` +
      `${typeof p.amountCents === "number" ? (p.amountCents / 100).toFixed(2) : "?"} ` +
      `${typeof p.currency === "string" ? p.currency.toUpperCase() : "USD"}` +
      `${typeof p.previousAmountCents === "number" ? ` (was ${(p.previousAmountCents / 100).toFixed(2)})` : ""}`
    ).slice(0, 140),
  execute(payload): Promise<Record<string, unknown>> {
    return Promise.resolve({
      recorded: true,
      executed: false, // the live link is minted by the monetization engine once this approval exists.
      planId: typeof payload.planId === "string" ? payload.planId : null,
      amountCents: typeof payload.amountCents === "number" ? payload.amountCents : null,
      currency: typeof payload.currency === "string" ? payload.currency : "usd",
      previousAmountCents:
        typeof payload.previousAmountCents === "number" ? payload.previousAmountCents : null,
    });
  },
};

/**
 * Outbound money boundary — changing a venture's payout settings (#188, ADR-0188). **Sensitive by
 * default** and **recorded-only**: approving records the owner's go; re-routing money is never
 * autonomous — the owner makes the change in the venture's own Stripe dashboard.
 */
const monetizationPayoutSettings: ActionExecutor = {
  actionType: MONETIZATION_PAYOUT_SETTINGS_ACTION,
  validate: validateMonetizationPayoutSettings,
  summarize: (p) =>
    `payout settings for ${String(p.ventureName ?? p.ventureId)} → ${String(p.destination)}`.slice(0, 140),
  execute(payload): Promise<Record<string, unknown>> {
    return Promise.resolve({
      recorded: true,
      executed: false,
      ventureId: typeof payload.ventureId === "string" ? payload.ventureId : null,
      destination: typeof payload.destination === "string" ? payload.destination : null,
    });
  },
};

/**
 * The outreach SEND (#225, ADR-0225). **Sensitive by default + IRREVERSIBLE** (deliverability/brand): it
 * ALWAYS pauses for the owner, who sees the exact recipient + content on the card. On approval it is
 * **recorded-only** — it flips the parked `outreach_messages` row to `sent` (recording the owner's go) and
 * makes NO network call. A real ESP/social adapter behind this gate is a deliberate future ADR; outreach
 * is never an autonomous send. Runs AS the requester (re-checks tenant ownership of the message at
 * execution, ADR-0013 §3).
 */
const outreachSend: ActionExecutor = {
  actionType: OUTREACH_SEND_ACTION,
  validate: validateOutreachSend,
  summarize: (p) =>
    (
      `outreach ${String(p.channel ?? "")} to ${String(p.recipientLabel ?? p.recipientRef ?? "")}: ` +
      `${String(p.subject || p.body || "").slice(0, 80)}`
    ).slice(0, 160),
  async execute(payload, ctx: ExecutorContext): Promise<Record<string, unknown>> {
    const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
    if (!messageId) throw new ActionExecutionError("messageId required");
    const updated = await markMessageSent(ctx.workspaceId, messageId, "dryrun");
    if (!updated) throw new ActionExecutionError("outreach message not found in this workspace");
    return {
      recorded: true,
      executed: false, // recorded-only: a real channel adapter behind this gate is a future ADR.
      sent: true,
      messageId,
      channel: updated.channel,
      provider: "dryrun",
    };
  },
};

/**
 * Reach paid prospect-data credit spend (#280) — a recorded-only MONEY decision. Buying credits from a
 * paid data provider (Clay/Lusha/Vibe) to find prospects is real, irreversible spend, so it pauses for the
 * owner with the exact estimated amount shown. Recorded-only: approving records the owner's go on the #13
 * audit trail; a real paid fetch behind this gate is a deliberate follow-up. The Reach SEND it enables is
 * never gated here — sending a marketing message is autonomous under the caps.
 */
const reachDataCreditSpend: ActionExecutor = {
  actionType: REACH_DATA_CREDIT_ACTION,
  validate: validateReachDataCreditSpend,
  summarize: (p) =>
    (
      `Reach data credits via ${String(p.provider ?? "?")}: ` +
      `${typeof p.amountCents === "number" ? `$${(p.amountCents / 100).toFixed(2)}` : "?"}` +
      `${typeof p.prospectCount === "number" ? ` for ~${p.prospectCount} prospects` : ""}`
    ).slice(0, 140),
  execute(payload): Promise<Record<string, unknown>> {
    return Promise.resolve({
      recorded: true,
      executed: false, // a real paid fetch behind this gate is a deliberate follow-up ADR.
      provider: typeof payload.provider === "string" ? payload.provider : null,
      amountCents: typeof payload.amountCents === "number" ? payload.amountCents : null,
    });
  },
};

/**
 * SkillOpt-Sleep skill-edit adoption (#283) — a recorded-only, behavior-altering decision the owner gates.
 * The self-improvement loop never adopts an edit itself; it parks this PENDING request and the owner
 * decides. Approving RECORDS the owner's go (the audit trail proves nothing changed an agent without a
 * human yes); actually applying the bounded append to the versioned skill doc is a deliberate follow-up, so
 * the executor writes no file and makes no network call.
 */
const skillOptAdoptEdit: ActionExecutor = {
  actionType: SKILLOPT_ADOPT_EDIT_ACTION,
  validate: validateSkillOptAdoptEdit,
  summarize: (p) =>
    (
      `adopt @${String(p.handle ?? "?")} skill edit (${String(p.skillId ?? "?")}): ` +
      `${String(p.appendText ?? "").slice(0, 80)}`
    ).slice(0, 160),
  execute(payload): Promise<Record<string, unknown>> {
    return Promise.resolve({
      recorded: true,
      executed: false, // applying the edit to the versioned skill doc is a deliberate follow-up ADR.
      handle: typeof payload.handle === "string" ? payload.handle : null,
      skillId: typeof payload.skillId === "string" ? payload.skillId : null,
      currentDocSha: typeof payload.currentDocSha === "string" ? payload.currentDocSha : null,
    });
  },
};

/**
 * Connect-once LIVE connect (#258 Stage 2) — a recorded-only CONSENT decision the owner gates. Connecting an
 * outside account is not money (ADR-0243) but touches a real external surface, so the connect-once seam
 * ALWAYS parks this PENDING request; there is no autonomous-connect path. Approving RECORDS the owner's go
 * (the audit trail proves no account was connected without a human yes); the live redirect + token exchange
 * + vault seal behind the gate is the per-department follow-up (#265/#268/#269/#272), so the executor mints
 * no credential and makes no network call.
 */
const connectAccount: ActionExecutor = {
  actionType: CONNECTION_CONNECT_ACCOUNT_ACTION,
  validate: validateConnectAccount,
  summarize: (p) =>
    `connect ${String(p.connectionId ?? "?")} (${String(p.provider ?? "?")})`.slice(0, 140),
  execute(payload): Promise<Record<string, unknown>> {
    return Promise.resolve({
      recorded: true,
      executed: false, // the live redirect + token exchange + vault seal is a per-department follow-up ADR.
      connectionId: typeof payload.connectionId === "string" ? payload.connectionId : null,
      provider: typeof payload.provider === "string" ? payload.provider : null,
    });
  },
};

/**
 * Build the executor registry with an injectable egress enforcer (#151), a send-layer compliance enforcer
 * (#196), an optional acquisition dispatcher (#189), and an optional delivery dispatcher (#295). The
 * compliance default is a no-op and both dispatchers are absent by default, so the `external.send` executor
 * stays recorded-only and the `agent.deliverable` executor stays a pure acknowledgement — byte-for-byte
 * today's behavior, every existing approval test untouched.
 */
export function buildDefaultRegistry(
  egress: EgressEnforcer = defaultEgressEnforcer,
  compliance: ComplianceEnforcer = noopComplianceEnforcer,
  dispatcher?: AcquisitionDispatcher,
  delivery?: DeliveryDispatcher,
  hosted?: HostedPublishDispatcher,
): ExecutorRegistry {
  return buildRegistry([
    chatPostMessage,
    makeAgentDeliverable(delivery),
    makeHostedPublish(hosted),
    makeExternalSend(egress, compliance, dispatcher),
    billingRefund,
    browserAction,
    ventureWeeklyPlanExecutor,
    financeDisbursement,
    monetizationActivatePrice,
    monetizationPayoutSettings,
    outreachSend,
    reachDataCreditSpend,
    skillOptAdoptEdit,
    connectAccount,
  ]);
}

/** The executors wired for this deployment (ADR-0013 §2, #98, #151, #196). The compliance enforcer is the
 * default-OFF legal pack: a no-op until a tenant turns `legal.enabled` on, so behavior is unchanged. */
export const defaultRegistry: ExecutorRegistry = buildDefaultRegistry(
  defaultEgressEnforcer,
  defaultComplianceEnforcer,
  undefined,
  undefined,
  buildHostedPublishDispatcher(),
);
