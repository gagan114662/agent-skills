/**
 * Outreach engine — IO orchestrator (#225, ADR-0225). Consumes the ranked discovery queue (#222) + the
 * buyer brief (#223) as DATA, composes a problem-led, channel-specific message (pure {@link composeMessage}),
 * and PARKS it at the #13 gate for one-tap owner approval. The byte-push happens only in the post-approval
 * `outreach.send` executor, after a human approves.
 *
 * GUARDRAILS — the dependency surface is the proof:
 *   - #200 (sends are IRREVERSIBLE: deliverability/brand): there is NO send/provider seam on this service.
 *     Every `queue()` call ends at a PENDING #13 request (pre-commitment, never post-hoc); the approval
 *     executor owns the real ESP call and records the provider id.
 *   - #223 (injection-quarantine end-to-end): there is NO live profile reader here — the brief is consumed
 *     as already-sanitized DATA, the recipient is built ONLY from structured identity (never read text),
 *     and the compose step is pure DATA→DATA. A poisoned enrichment read can place sanitized text on an
 *     owner-reviewed card; it can never change who is contacted or trigger a send.
 *   - metrics from external receipts ONLY (#200 §2): an experiment concludes off `outreach_receipts`
 *     (reply/meeting/signup, each with a non-empty external_ref); projections are labeled UNVERIFIED.
 *   - the engine advances the #222 GTM pipeline only through a narrow {@link PipelineAdvancer} that can do
 *     nothing but record an externally-grounded conversion.
 */

import type { ServiceKind } from "../onboarding/types.js";
import type { BuyerBriefRecord } from "../decision-maker/types.js";
import type { DiscoveryQueue } from "../discovery/contract.js";
import type { GtmStage } from "../discovery/score.js";
import { decideToolGate } from "../realworld/decide.js";
import type { OutreachCaps } from "./caps.js";
import {
  channelPreference,
  composeMessage,
  concludeExperiment,
  selectChannel,
  selectVariant,
  type ComposeBuyer,
  type ExperimentConclusion,
  type VariantTally,
} from "./compose.js";
import {
  OUTREACH_CHANNELS,
  channelTool,
  isOutreachReceiptKind,
  type ComposedMessage,
  type OutreachChannel,
  type OutreachMessageRecord,
  type OutreachReceiptKind,
  type OutreachReceiptRecord,
  type OutreachReplyThread,
  type ValuePropVariant,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Thrown when an outreach input fails validation (unknown receipt kind, missing brief, missing proof). */
export class OutreachValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutreachValidationError";
  }
}

// ---------------------------------------------------------------------------------------------------
// Seams — every side effect is one narrow interface so the service runs on fakes in tests.
// ---------------------------------------------------------------------------------------------------

/** Read the #222 ranked discovery queue (DATA). A subset of `DiscoveryService` — read-only by design. */
export interface ProspectReader {
  queue(workspaceId: string, opts?: { ideaId?: string; limit?: number }): Promise<DiscoveryQueue>;
}

/** Read a persisted #223 buyer brief (sanitized DATA — NOT a live profile reader). */
export interface BriefReader {
  get(workspaceId: string, id: string): Promise<BuyerBriefRecord | undefined>;
}

/**
 * Advance the #222 GTM pipeline when an EXTERNAL receipt lands. Deliberately narrow: it can ONLY advance
 * one named prospect to a canonical GTM stage. The outreach engine holds no other discovery capability.
 */
export interface PipelineAdvancer {
  recordStage(
    workspaceId: string,
    input: {
      ideaId: string | null;
      prospectKey: string;
      stage: GtmStage;
      externalRef: string;
      detail: Record<string, unknown>;
    },
  ): Promise<void>;
}

export interface MessageInsertInput {
  workspaceId: string;
  ideaId: string | null;
  prospectKey: string;
  accountId: string | null;
  buyerBriefId: string | null;
  channel: OutreachChannel;
  variant: ValuePropVariant;
  signalKind: string | null;
  subject: string;
  body: string;
  recipientLabel: string;
  recipientRef: string;
  experimentKey: string;
  status: OutreachMessageRecord["status"];
  provider: string;
  spamRiskScore: number;
  spamRiskLevel: OutreachMessageRecord["spamRiskLevel"];
  spamRiskReasons: string[];
}

export interface MessageStore {
  insert(input: MessageInsertInput): Promise<OutreachMessageRecord>;
  get(workspaceId: string, id: string): Promise<OutreachMessageRecord | undefined>;
  findByRecipientRef?(
    workspaceId: string,
    recipientRef: string,
  ): Promise<OutreachMessageRecord | undefined>;
  setApproval(
    workspaceId: string,
    id: string,
    update: { status: OutreachMessageRecord["status"]; approvalRequestId: string | null },
  ): Promise<void>;
  list(
    workspaceId: string,
    opts?: { ideaId?: string; limit?: number },
  ): Promise<OutreachMessageRecord[]>;
  /** Count messages on a channel that count toward the rate cap (parked + sent) since `since`. */
  countActiveOnChannel(workspaceId: string, channel: OutreachChannel, since: Date): Promise<number>;
}

export interface ReceiptStore {
  insert(input: {
    workspaceId: string;
    messageId: string;
    kind: OutreachReceiptKind;
    externalRef: string;
    replyBody?: string | null;
    replyFrom?: string | null;
    replySubject?: string | null;
    occurredAt: Date;
  }): Promise<{ record: OutreachReceiptRecord; created: boolean }>;
  list(workspaceId: string, opts?: { ideaId?: string }): Promise<OutreachReceiptRecord[]>;
}

/**
 * Optional trackable pay-link minter (Leads Centre GAP 3, ADR-0401). When wired AND `caps.payLinkInOutreach`
 * is on, the service mints an inbound-only Stripe collection link for the prospect (a #386-tracked URL) and
 * the composer appends a single "Start here: <url>" line to the body. Minting a collection link is NOT
 * money-out (a charge/payout stays #13-gated); the SEND still parks at the #13 gate. Returns `null` to mean
 * "no pay link available" — the body is then byte-for-byte unchanged. Best-effort: a mint failure must never
 * break composition (the body falls back to no link).
 */
export interface OutreachPayLinkMinter {
  mintForProspect(
    workspaceId: string,
    input: { leadOrArtifactId: string; channel: OutreachChannel; planId: string },
  ): Promise<{ url: string } | null>;
}

/** The #13 approval seam (reuses the approvals policy + queue; recorded-only until a human approves). */
export interface OutreachApprovalGate {
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    summary: string;
    payload: Record<string, unknown>;
    actionType?: string;
  }): Promise<{ id: string }>;
}

export interface OutreachDeps {
  prospects: ProspectReader;
  briefs: BriefReader;
  messages: MessageStore;
  receipts: ReceiptStore;
  approvals: OutreachApprovalGate;
  /** Optional #222 pipeline advancer — absent ⇒ receipts are still recorded, the funnel just isn't advanced. */
  pipeline?: PipelineAdvancer;
  /** Optional GAP 3 pay-link minter — absent OR flag-off ⇒ no pay link is appended (body unchanged). */
  payLinks?: OutreachPayLinkMinter;
  /** Plan id a pay link collects against when `caps.payLinkInOutreach` is on (defaults to "pro"). */
  payLinkPlanId?: string;
  connectedAccounts: (workspaceId: string) => Promise<ReadonlySet<ServiceKind>>;
  caps: (workspaceId: string) => OutreachCaps;
  now?: () => Date;
}

// ---------------------------------------------------------------------------------------------------
// Result types.
// ---------------------------------------------------------------------------------------------------

export interface DraftResult {
  message: ComposedMessage;
  /** True iff the chosen channel's account is connected (so the send could actually go out). */
  channelConnected: boolean;
  missingAccounts: ServiceKind[];
  experimentKey: string;
}

export type QueueResult =
  | { status: "blocked"; reason: string; missingAccounts: ServiceKind[]; messageId: string }
  | { status: "rate_limited"; channel: OutreachChannel; cap: number }
  | {
      status: "pending_approval";
      approvalRequestId: string;
      messageId: string;
      channel: OutreachChannel;
    };

export interface OutreachCallPrepHandoff {
  source: "outreach.call_prep";
  messageId: string;
  receiptId: string;
  prospectKey: string;
  externalRef: string;
  buyerBriefId: string;
  accountName: string;
  accountDomain: string;
  buyerName: string;
  buyerTitle: string;
  rationale: string;
  caresAbout: string[];
  hooks: Array<{ angle: string; sourceUrl: string; evidence: string }>;
}

/** The founder-console outreach roll-up (#104/#222 growth surface). All counts are real, never placeholders. */
export interface OutreachSummary {
  experimentsRunning: number;
  experimentsConcluded: number;
  messagesPendingApproval: number;
  messagesSent: number;
  messagesBlocked: number;
  /** External receipts (the only verified outreach metrics). */
  replies: number;
  meetings: number;
  signups: number;
  recentReplies: Array<{
    receiptId: string;
    messageId: string;
    recipientLabel: string;
    replyBody: string | null;
    replyFrom: string | null;
    replySubject: string | null;
    occurredAt: Date;
  }>;
}

function briefToBuyer(brief: BuyerBriefRecord): ComposeBuyer {
  return {
    buyerName: brief.buyerName,
    buyerTitle: brief.buyerTitle,
    buyerRole: brief.buyerRole,
    buyerContactId: brief.buyerContactId,
    accountId: brief.accountId,
    accountName: brief.accountName,
    // The brief carries no separate pain area; compose falls back topic → painArea → generic.
    painArea: "",
    caresAbout: brief.caresAbout,
    hooks: brief.hooks.map((h) => ({ angle: h.angle, evidence: h.evidence })),
  };
}

export class OutreachService {
  private readonly deps: OutreachDeps;
  private readonly now: () => Date;

  constructor(deps: OutreachDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * The channels a send could actually go out on — i.e. whose #231 tool gate is satisfied by the
   * connected accounts. Authoritative: it reuses {@link decideToolGate} (send_email needs esp+registrar,
   * send_sms needs an opted-in SMS account, post_social needs an ad account), so the engine never selects
   * a channel that would be blocked.
   */
  async availableChannels(workspaceId: string): Promise<Set<OutreachChannel>> {
    const connectedAccounts = await this.deps.connectedAccounts(workspaceId);
    const set = new Set<OutreachChannel>();
    for (const c of OUTREACH_CHANNELS) {
      if (decideToolGate(channelTool(c), { connectedAccounts }).allowed) set.add(c);
    }
    return set;
  }

  /**
   * Resolve the trackable pay-link URL to append to the body (GAP 3), or `undefined` when none should be
   * appended. Gated by `caps.payLinkInOutreach` AND a wired minter — default-OFF ⇒ no link, body unchanged.
   * The lead/artifact id is the structural prospect key (never read text). Best-effort: a mint failure or a
   * `null` return yields `undefined` so composition is never broken by the pay-link path.
   */
  private async resolvePayLinkUrl(
    workspaceId: string,
    prospectKey: string,
    channel: OutreachChannel,
  ): Promise<string | undefined> {
    const caps = this.deps.caps(workspaceId);
    if (!caps.payLinkInOutreach || !this.deps.payLinks) return undefined;
    try {
      const link = await this.deps.payLinks.mintForProspect(workspaceId, {
        leadOrArtifactId: prospectKey,
        channel,
        planId: this.deps.payLinkPlanId ?? "pro",
      });
      return link?.url;
    } catch {
      return undefined;
    }
  }

  private async resolve(
    workspaceId: string,
    prospectKey: string,
    buyerBriefId: string,
    ideaId: string | null,
  ): Promise<{ brief: BuyerBriefRecord; signalKinds: string[] }> {
    const brief = await this.deps.briefs.get(workspaceId, buyerBriefId);
    if (!brief) throw new OutreachValidationError(`buyer brief not found: ${buyerBriefId}`);
    const queue = await this.deps.prospects.queue(workspaceId, {
      ideaId: ideaId ?? undefined,
    });
    const prospect = queue.prospects.find((p) => p.prospectKey === prospectKey);
    const signalKinds = prospect ? [...prospect.qualifyingSignalKinds] : [];
    return { brief, signalKinds };
  }

  /**
   * Compose a preview message for a (prospect, brief) pair WITHOUT persisting or queueing anything. Pure
   * DATA out — useful for the route preview + tests. The channel is auto-selected from the PQL signal,
   * preferring a connected channel.
   */
  async draft(
    workspaceId: string,
    input: {
      prospectKey: string;
      buyerBriefId: string;
      ideaId?: string | null;
      productName?: string;
    },
  ): Promise<DraftResult> {
    const ideaId = input.ideaId ?? null;
    const { brief, signalKinds } = await this.resolve(
      workspaceId,
      input.prospectKey,
      input.buyerBriefId,
      ideaId,
    );
    const available = await this.availableChannels(workspaceId);
    const channel: OutreachChannel =
      selectChannel(signalKinds, available) ?? channelPreference(signalKinds)[0] ?? "email";
    const variant = selectVariant(input.prospectKey);
    const payLinkUrl = await this.resolvePayLinkUrl(workspaceId, input.prospectKey, channel);
    const message = composeMessage({
      prospectKey: input.prospectKey,
      signalKinds,
      channel,
      variant,
      buyer: briefToBuyer(brief),
      productName: input.productName ?? "",
      ...(payLinkUrl ? { payLinkUrl } : {}),
    });
    const gate = decideToolGate(channelTool(channel), {
      connectedAccounts: await this.deps.connectedAccounts(workspaceId),
    });
    return {
      message,
      channelConnected: gate.allowed,
      missingAccounts: gate.missingAccounts,
      experimentKey: `${ideaId ?? "workspace"}:${channel}`,
    };
  }

  /**
   * Compose + PARK an outreach message for one-tap owner approval (AC1). NEVER sends: it ends at a PENDING
   * #13 request with the exact recipient + content on the card. Blocks (with what to connect) when the
   * channel's account isn't connected; rate-limits per channel (premortem #200: deliverability/brand).
   */
  async queue(
    workspaceId: string,
    input: {
      prospectKey: string;
      buyerBriefId: string;
      ideaId?: string | null;
      productName?: string;
      requesterMemberId: string;
    },
  ): Promise<QueueResult> {
    const ideaId = input.ideaId ?? null;
    const caps = this.deps.caps(workspaceId);
    const { brief, signalKinds } = await this.resolve(
      workspaceId,
      input.prospectKey,
      input.buyerBriefId,
      ideaId,
    );
    const available = await this.availableChannels(workspaceId);
    const channel: OutreachChannel =
      selectChannel(signalKinds, available) ?? channelPreference(signalKinds)[0] ?? "email";
    const variant = selectVariant(input.prospectKey);
    const experimentKey = `${ideaId ?? "workspace"}:${channel}`;
    const signalKind = signalKinds[0] ?? null;

    const payLinkUrl = await this.resolvePayLinkUrl(workspaceId, input.prospectKey, channel);
    const message = composeMessage({
      prospectKey: input.prospectKey,
      signalKinds,
      channel,
      variant,
      buyer: briefToBuyer(brief),
      productName: input.productName ?? "",
      ...(payLinkUrl ? { payLinkUrl } : {}),
    });

    const connected = await this.deps.connectedAccounts(workspaceId);
    const gate = decideToolGate(channelTool(channel), { connectedAccounts: connected });
    if (!gate.allowed) {
      const blocked = await this.deps.messages.insert({
        workspaceId,
        ideaId,
        prospectKey: input.prospectKey,
        accountId: brief.accountId,
        buyerBriefId: brief.id,
        channel,
        variant,
        signalKind,
        subject: message.subject,
        body: message.body,
        recipientLabel: message.recipientLabel,
        recipientRef: message.recipientRef,
        spamRiskScore: message.spamRisk.score,
        spamRiskLevel: message.spamRisk.level,
        spamRiskReasons: message.spamRisk.reasons,
        experimentKey,
        status: "blocked",
        provider: caps.sendProvider,
      });
      return {
        status: "blocked",
        reason: gate.reason,
        missingAccounts: gate.missingAccounts,
        messageId: blocked.id,
      };
    }

    // Per-channel rate cap (deliverability/brand): count parked + sent in the last 24h.
    const since = new Date(this.now().getTime() - DAY_MS);
    const active = await this.deps.messages.countActiveOnChannel(workspaceId, channel, since);
    if (active >= caps.perChannelDailyCap) {
      return { status: "rate_limited", channel, cap: caps.perChannelDailyCap };
    }

    const stored = await this.deps.messages.insert({
      workspaceId,
      ideaId,
      prospectKey: input.prospectKey,
      accountId: brief.accountId,
      buyerBriefId: brief.id,
      channel,
      variant,
      signalKind,
      subject: message.subject,
      body: message.body,
      recipientLabel: message.recipientLabel,
      recipientRef: message.recipientRef,
      spamRiskScore: message.spamRisk.score,
      spamRiskLevel: message.spamRisk.level,
      spamRiskReasons: message.spamRisk.reasons,
      experimentKey,
      status: "drafted",
      provider: caps.sendProvider,
    });

    // ALWAYS park — outreach is pre-committed/owner-gated, never autonomous (premortem #200). The exact
    // recipient + content live on the card; the read-derived grounding rides along as DATA for the owner.
    const riskPrefix =
      message.spamRisk.level === "clean" ? "" : `[${message.spamRisk.level} spam risk] `;
    const summary =
      `${riskPrefix}Send ${channel} to ${message.recipientLabel}: ` +
      `${(message.subject || message.body).slice(0, 80)}`;
    const approval = await this.deps.approvals.submit({
      workspaceId,
      requesterMemberId: input.requesterMemberId,
      summary,
      payload: {
        source: "outreach",
        messageId: stored.id,
        channel,
        variant,
        prospectKey: input.prospectKey,
        recipientRef: message.recipientRef,
        recipientLabel: message.recipientLabel,
        subject: message.subject,
        body: message.body,
        groundingEvidence: message.groundingEvidence,
        spamRisk: message.spamRisk,
      },
    });
    await this.deps.messages.setApproval(workspaceId, stored.id, {
      status: "pending_approval",
      approvalRequestId: approval.id,
    });

    return {
      status: "pending_approval",
      approvalRequestId: approval.id,
      messageId: stored.id,
      channel,
    };
  }

  /**
   * Record an EXTERNAL receipt (a reply, a booked meeting, a signup) — the only thing that moves an
   * experiment or the GTM pipeline (premortem #200 §2). Requires a non-empty `externalRef` (the proof).
   * Idempotent. When a #222 pipeline advancer is wired, the receipt advances the prospect into the
   * conversion step (verified) and lights up the founder-console growth funnel.
   */
  async recordReceipt(
    workspaceId: string,
    input: {
      messageId: string;
      kind: string;
      externalRef: string;
      occurredAt?: Date;
      replyBody?: string | null;
      replyFrom?: string | null;
      replySubject?: string | null;
    },
  ): Promise<{ receipt: OutreachReceiptRecord; created: boolean; callPrep?: OutreachCallPrepHandoff }> {
    if (!isOutreachReceiptKind(input.kind)) {
      throw new OutreachValidationError("kind must be one of reply, meeting, signup");
    }
    const externalRef = input.externalRef?.trim() ?? "";
    if (externalRef.length === 0) {
      throw new OutreachValidationError(
        "an external receipt requires a non-empty externalRef (the proof it is external)",
      );
    }
    const message = await this.deps.messages.get(workspaceId, input.messageId);
    if (!message)
      throw new OutreachValidationError(`outreach message not found: ${input.messageId}`);

    const { record, created } = await this.deps.receipts.insert({
      workspaceId,
      messageId: input.messageId,
      kind: input.kind,
      externalRef,
      replyBody: input.replyBody ?? null,
      replyFrom: input.replyFrom ?? null,
      replySubject: input.replySubject ?? null,
      occurredAt: input.occurredAt ?? this.now(),
    });

    // Route real receipts into the GTM pipeline. Replies/meetings are sales conversions; signups are the
    // first self-serve onboarding step. All require the external receipt above.
    if (created && this.deps.pipeline) {
      await this.deps.pipeline.recordStage(workspaceId, {
        ideaId: message.ideaId,
        prospectKey: message.prospectKey,
        stage: input.kind === "signup" ? "onboarding" : "conversion",
        externalRef,
        detail: { receiptKind: input.kind, messageId: input.messageId, source: "outreach" },
      });
    }
    let callPrep: OutreachCallPrepHandoff | undefined;
    if (created && input.kind === "meeting" && message.buyerBriefId) {
      const brief = await this.deps.briefs.get(workspaceId, message.buyerBriefId);
      if (brief) {
        callPrep = {
          source: "outreach.call_prep",
          messageId: input.messageId,
          receiptId: record.id,
          prospectKey: message.prospectKey,
          externalRef,
          buyerBriefId: brief.id,
          accountName: brief.accountName,
          accountDomain: brief.accountDomain,
          buyerName: brief.buyerName,
          buyerTitle: brief.buyerTitle,
          rationale: brief.rationale,
          caresAbout: brief.caresAbout,
          hooks: brief.hooks.map((hook) => ({
            angle: hook.angle,
            sourceUrl: hook.sourceUrl,
            evidence: hook.evidence,
          })),
        };
      }
    }
    return { receipt: record, created, ...(callPrep ? { callPrep } : {}) };
  }

  async replyThreads(workspaceId: string): Promise<OutreachReplyThread[]> {
    const [messages, receipts] = await Promise.all([
      this.deps.messages.list(workspaceId, { limit: 500 }),
      this.deps.receipts.list(workspaceId),
    ]);
    const byId = new Map(messages.map((message) => [message.id, message]));
    return receipts
      .filter((receipt) => receipt.kind === "reply")
      .map((receipt) => {
        const message = byId.get(receipt.messageId);
        return message ? { receipt, message } : null;
      })
      .filter((thread): thread is OutreachReplyThread => thread !== null);
  }

  async recordInboundReply(
    workspaceId: string,
    input: {
      externalRef: string;
      messageId?: string | null;
      recipientRef?: string | null;
      replyBody?: string | null;
      replyFrom?: string | null;
      replySubject?: string | null;
      occurredAt?: Date;
    },
  ): Promise<{ matched: boolean; created: boolean; messageId?: string }> {
    const externalRef = input.externalRef.trim();
    if (!externalRef) return { matched: false, created: false };
    let message = input.messageId
      ? await this.deps.messages.get(workspaceId, input.messageId)
      : undefined;
    const recipientRef = input.recipientRef?.trim();
    if (!message && recipientRef && this.deps.messages.findByRecipientRef) {
      message = await this.deps.messages.findByRecipientRef(workspaceId, recipientRef);
    }
    if (!message) return { matched: false, created: false };
    const { created } = await this.recordReceipt(workspaceId, {
      messageId: message.id,
      kind: "reply",
      externalRef,
      replyBody: input.replyBody,
      replyFrom: input.replyFrom,
      replySubject: input.replySubject,
      occurredAt: input.occurredAt,
    });
    return { matched: true, created, messageId: message.id };
  }

  /** Compute every running/concluded message experiment from external receipts (AC2). Read-only. */
  async experiments(workspaceId: string, ideaId?: string): Promise<ExperimentConclusion[]> {
    const [messages, receipts] = await Promise.all([
      this.deps.messages.list(workspaceId, { ideaId }),
      this.deps.receipts.list(workspaceId, { ideaId }),
    ]);
    const variantByMessage = new Map<
      string,
      { experimentKey: string; variant: ValuePropVariant }
    >();
    // key: `${experimentKey}\u001f${variant}` → tally
    const tallies = new Map<string, VariantTally>();
    const experimentKeys = new Set<string>();

    const tallyKey = (experimentKey: string, variant: ValuePropVariant): string =>
      `${experimentKey}\u001f${variant}`;
    const ensure = (experimentKey: string, variant: ValuePropVariant): VariantTally => {
      const k = tallyKey(experimentKey, variant);
      let t = tallies.get(k);
      if (!t) {
        t = { variant, sent: 0, replies: 0, meetings: 0, signups: 0 };
        tallies.set(k, t);
      }
      return t;
    };

    for (const m of messages) {
      experimentKeys.add(m.experimentKey);
      variantByMessage.set(m.id, { experimentKey: m.experimentKey, variant: m.variant });
      if (m.status === "sent") ensure(m.experimentKey, m.variant).sent += 1;
    }
    for (const r of receipts) {
      const ref = variantByMessage.get(r.messageId);
      if (!ref) continue;
      const t = ensure(ref.experimentKey, ref.variant);
      if (r.kind === "reply") t.replies += 1;
      else if (r.kind === "meeting") t.meetings += 1;
      else if (r.kind === "signup") t.signups += 1;
    }

    return [...experimentKeys].sort().map((key) => {
      const ts: VariantTally[] = [];
      for (const v of ["time_saved", "productivity", "cost"] as ValuePropVariant[]) {
        const t = tallies.get(tallyKey(key, v));
        if (t) ts.push(t);
      }
      return concludeExperiment(key, ts);
    });
  }

  /** The founder-console outreach roll-up (AC2): experiments running + external reply/meeting counts. */
  async summary(workspaceId: string): Promise<OutreachSummary> {
    const [messages, receipts, experiments] = await Promise.all([
      this.deps.messages.list(workspaceId, {}),
      this.deps.receipts.list(workspaceId, {}),
      this.experiments(workspaceId),
    ]);
    let pending = 0;
    let sent = 0;
    let blocked = 0;
    for (const m of messages) {
      if (m.status === "pending_approval") pending += 1;
      else if (m.status === "sent") sent += 1;
      else if (m.status === "blocked") blocked += 1;
    }
    let replies = 0;
    let meetings = 0;
    let signups = 0;
    for (const r of receipts) {
      if (r.kind === "reply") replies += 1;
      else if (r.kind === "meeting") meetings += 1;
      else if (r.kind === "signup") signups += 1;
    }
    const messageById = new Map(messages.map((message) => [message.id, message]));
    const recentReplies = receipts
      .filter((receipt) => receipt.kind === "reply")
      .slice(0, 10)
      .map((receipt) => {
        const message = messageById.get(receipt.messageId);
        return {
          receiptId: receipt.id,
          messageId: receipt.messageId,
          recipientLabel: message?.recipientLabel ?? "",
          replyBody: receipt.replyBody,
          replyFrom: receipt.replyFrom,
          replySubject: receipt.replySubject,
          occurredAt: receipt.occurredAt,
        };
      });
    return {
      experimentsRunning: experiments.filter((e) => e.status === "running").length,
      experimentsConcluded: experiments.filter((e) => e.status === "concluded").length,
      messagesPendingApproval: pending,
      messagesSent: sent,
      messagesBlocked: blocked,
      replies,
      meetings,
      signups,
      recentReplies,
    };
  }

  async listMessages(
    workspaceId: string,
    opts?: { ideaId?: string; limit?: number },
  ): Promise<OutreachMessageRecord[]> {
    return this.deps.messages.list(workspaceId, opts);
  }
}
