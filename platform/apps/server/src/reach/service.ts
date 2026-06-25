import type { FastifyBaseLogger } from "fastify";
import type { SenderAuthInput } from "../email/deliverability.js";
import { isPlausibleEmail } from "../leads/inbound.js";
import { checkSpamRisk } from "../outreach/compose.js";
import type { ReachCaps, ReachSendingDomain } from "./caps.js";
import {
  DEFAULT_CADENCE,
  advanceEnrollment,
  newEnrollment,
  nextDueStep,
  type CadenceEnrollment,
} from "./cadence.js";
import { deriveIcp, type IcpSeed } from "./icp.js";
import { computeMetrics, type ReachMetrics, type ReceiptDatum, type SendDatum } from "./measure.js";
import { composeFollowUp, personalizeOpener } from "./personalize.js";
import { ProspectSourceUnavailableError, type ProspectSource } from "./prospect-source.js";
import { rankBatch } from "./score.js";
import {
  REACH_TUNING_DEFAULTS,
  tuneNextBatch,
  type ReachTuningConfig,
  type TuningReport,
} from "./self-tune.js";
import type { ReachChannelAdapter } from "./channel.js";
import type {
  ProspectSourceKind,
  RawProspect,
  ReachChannel,
  ReachMessage,
  ReachReceiptKind,
  ReachRunStatus,
  ReachSendStatus,
} from "./types.js";

/**
 * ReachService (#280) — the orchestration of the self-improving outbound loop. `runBatch` runs the eight
 * steps end to end: learn the ICP → source prospects (money-gating a paid source FIRST) → score + dedupe
 * against everyone already contacted → personalise a 1:1 opener → send under the per-domain cap +
 * suppression → enrol in a cadence → measure → self-tune the next batch. Every side effect goes through an
 * injected seam, so the whole loop is unit-testable with in-memory fakes and the same code drives the real
 * cron. Default-OFF: a disabled workspace records a skipped run and sends nothing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TUNING_WINDOW_MS = 30 * DAY_MS;

function warmupDailyCap(recentSent: number, configuredCap: number): number {
  if (recentSent >= 100) return configuredCap;
  if (recentSent >= 50) return Math.min(configuredCap, 40);
  if (recentSent >= 20) return Math.min(configuredCap, 25);
  return Math.min(configuredCap, 10);
}

function appendAuditDetail(base: string, extra: Record<string, unknown>): string {
  const suffix = JSON.stringify(extra);
  return base ? base + "; " + suffix : suffix;
}

interface DomainState {
  from: string | null;
  domain: string | null;
  dailyCap: number;
  sentToday: number;
  effectiveDailyCap: number;
  pauseReason: string | null;
}

function legacyDomainState(input: {
  sentToday: number;
  effectiveDailyCap: number;
  dailyCap: number;
  pauseReason: string | null;
}): DomainState {
  return {
    from: null,
    domain: null,
    dailyCap: input.dailyCap,
    sentToday: input.sentToday,
    effectiveDailyCap: input.effectiveDailyCap,
    pauseReason: input.pauseReason,
  };
}

function domainPauseReason(input: {
  sent: number;
  bounceRate: number;
  complaintRate: number;
  maxBounceRate: number;
  maxComplaintRate: number;
}): string | null {
  return input.sent > 0 && input.bounceRate > input.maxBounceRate
    ? "bounce rate " +
        (input.bounceRate * 100).toFixed(1) +
        "% exceeds " +
        (input.maxBounceRate * 100).toFixed(1) +
        "%"
    : input.sent > 0 && input.complaintRate > input.maxComplaintRate
      ? "complaint rate " +
        (input.complaintRate * 100).toFixed(2) +
        "% exceeds " +
        (input.maxComplaintRate * 100).toFixed(2) +
        "%"
      : null;
}

function chooseDomain(states: DomainState[]): DomainState | null {
  return states
    .filter((s) => !s.pauseReason && s.sentToday < s.effectiveDailyCap)
    .sort((a, b) => (b.effectiveDailyCap - b.sentToday) - (a.effectiveDailyCap - a.sentToday))[0] ?? null;
}

// ---- seams ---------------------------------------------------------------------------------------

/** The ICP seed reader — pulls the workspace domain + founder-console hints. */
export interface ReachIcpReader {
  seed(workspaceId: string): Promise<IcpSeed>;
}

/** Resolve the configured prospect source (by kind) for a workspace. */
export type ReachSourceResolver = (workspaceId: string, kind: ProspectSourceKind) => ProspectSource;

export interface EnrollmentUpsert {
  workspaceId: string;
  contactKey: string;
  recipientLabel: string;
  channel: ReachChannel;
  enrollment: CadenceEnrollment;
  score: number;
  signalKind: string | null;
}

/** An active cadence enrolment, for processing a due follow-up touch. */
export interface ActiveEnrollment {
  contactKey: string;
  recipientLabel: string;
  channel: ReachChannel;
  currentStep: number;
  lastStepAtMs: number;
  /** The enrolment's fit score, preserved across follow-up advances. */
  score: number;
  /** The signal the opener was built around, preserved across follow-up advances. */
  signalKind: string | null;
}

export interface ImportedProspectInput {
  fullName: string;
  title?: string | null;
  company: string;
  companyDomain?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  industry?: string | null;
  companySize?: string | null;
  signalKind?: RawProspect["signals"][number]["kind"] | null;
  signalSummary?: string | null;
  observedAtMs?: number | null;
}

export interface ImportProspectsResult {
  imported: number;
  updated: number;
  skipped: number;
}

export interface ReachContactStore {
  /** Every contact_key we've already enrolled (the dedupe set — never re-touch last week's list). */
  contactedKeys(workspaceId: string): Promise<Set<string>>;
  importProspects(
    workspaceId: string,
    prospects: ImportedProspectInput[],
    now: Date,
  ): Promise<ImportProspectsResult>;
  importedProspects(
    workspaceId: string,
    limit: number,
    excludeKeys: ReadonlySet<string>,
  ): Promise<RawProspect[]>;
  /** Create or advance a cadence enrolment. */
  upsertEnrollment(input: EnrollmentUpsert): Promise<void>;
  /** Mark a contact replied / opted_out (stops the cadence). */
  markStatus(
    workspaceId: string,
    contactKey: string,
    status: "replied" | "opted_out",
  ): Promise<void>;
  /** Active enrolments (status `active`) — the service filters these to the ones with a DUE follow-up step. */
  activeEnrollments(workspaceId: string): Promise<ActiveEnrollment[]>;
}

export interface SendInsert {
  workspaceId: string;
  contactKey: string;
  channel: ReachChannel;
  status: ReachSendStatus;
  variant: ReachTuningConfig["variant"];
  signalKind: string | null;
  subject: string;
  externalId: string | null;
  sentHourUtc: number | null;
  sendingDomain?: string | null;
  detail: string;
}

export interface ReachSendStore {
  /** Count messages actually SENT since `since` (the per-sending-domain rate-cap denominator). */
  countSentSince(workspaceId: string, since: Date, sendingDomain?: string | null): Promise<number>;
  insert(input: SendInsert): Promise<{ id: string }>;
  /** The most recent send for a contact (to attach a receipt to). */
  latestSendId(workspaceId: string, contactKey: string): Promise<string | null>;
  findByExternalId?(
    workspaceId: string,
    externalId: string,
  ): Promise<{ id: string; contactKey: string } | null>;
  /** Flattened sent rows since `since`, for measurement. */
  sendsSince(workspaceId: string, since: Date): Promise<SendDatum[]>;
}

export interface ReceiptInsert {
  workspaceId: string;
  sendId: string;
  contactKey: string;
  kind: ReachReceiptKind;
  externalRef: string;
  replyBody?: string | null;
  replyFrom?: string | null;
  replySubject?: string | null;
  occurredAt: Date;
}

export interface ReachReceiptStore {
  /** Idempotent insert (returns false on a duplicate external receipt). */
  record(input: ReceiptInsert): Promise<{ recorded: boolean }>;
  /** Receipts since `since`, pre-attributed to the originating send's variant/signal/hour. */
  receiptData(workspaceId: string, since: Date): Promise<ReceiptDatum[]>;
  replyThreads?(workspaceId: string, limit?: number): Promise<ReachReplyThread[]>;
}

export interface RunInsert {
  workspaceId: string;
  sourceKind: string;
  status: ReachRunStatus;
  prospectsFound: number;
  messagesSent: number;
  messagesQueued: number;
  suppressedCount: number;
  rateLimitedCount: number;
  tuningReport: Record<string, unknown> | null;
}

export interface ReachRunStore {
  insert(input: RunInsert): Promise<{ id: string }>;
  /** The tuning config the last completed run produced (to continue learning), or null. */
  latestTuning(workspaceId: string): Promise<ReachTuningConfig | null>;
}

/** Parks a money-gated data-credit spend (#13). Returns the pending request id. */
export interface ReachApprovalGate {
  dataCreditSpend(
    workspaceId: string,
    provider: string,
  ): Promise<{
    pendingCents: number;
    approvedCents: number;
    pendingRequestId: string | null;
  }>;
  submitDataCreditSpend(input: {
    workspaceId: string;
    provider: string;
    amountCents: number;
    prospectCount: number;
    summary: string;
  }): Promise<{ requestId: string }>;
}

export interface ReachSuppressionStore {
  /** The opt-out/suppression set (reuses the #189 `dbSuppressionStore`). */
  loadSuppressed(workspaceId: string): Promise<ReadonlySet<string>>;
}

export interface ReachDeps {
  icp: ReachIcpReader;
  resolveSource: ReachSourceResolver;
  channels: Record<ReachChannel, ReachChannelAdapter>;
  contacts: ReachContactStore;
  sends: ReachSendStore;
  receipts: ReachReceiptStore;
  runs: ReachRunStore;
  approvals: ReachApprovalGate;
  suppressions: ReachSuppressionStore;
  deliverability?: {
    proof(
      workspaceId: string,
    ): Promise<{ auth: SenderAuthInput; authResultsHeader?: string | null } | null>;
  };
  caps: (workspaceId: string) => ReachCaps;
  now?: () => Date;
  log?: FastifyBaseLogger;
}

// ---- results -------------------------------------------------------------------------------------

export interface ReachOutcome {
  contactKey: string;
  channel: ReachChannel;
  status: ReachSendStatus;
}

export interface ReachRunResult {
  status: ReachRunStatus;
  /** Why a run was skipped / parked (human-readable). */
  reason: string;
  prospectsFound: number;
  messagesSent: number;
  messagesQueued: number;
  suppressed: number;
  rateLimited: number;
  skipped: number;
  outcomes: ReachOutcome[];
  tuning: TuningReport | null;
  /** Present when the run parked a money-gated data-credit spend. */
  approvalRequestId?: string;
}

export interface ReachSummary {
  prospectsFound: number;
  messagesSent: number;
  replies: number;
  booked: number;
}

export interface ReachReplyThread {
  receiptId: string;
  sendId: string;
  contactKey: string;
  externalRef: string;
  replyBody: string | null;
  replyFrom: string | null;
  replySubject: string | null;
  occurredAt: Date;
  createdAt: Date;
}

export class ReachService {
  constructor(private readonly deps: ReachDeps) {}

  async importProspects(
    workspaceId: string,
    prospects: ImportedProspectInput[],
  ): Promise<ImportProspectsResult> {
    return this.deps.contacts.importProspects(workspaceId, prospects, this.now());
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Pick the channel for a prospect: email when we have an address, else LinkedIn, else none. */
  private channelFor(email: string | null, linkedinUrl: string | null): ReachChannel | null {
    if (email && isPlausibleEmail(email.trim())) return "email";
    if (linkedinUrl && linkedinUrl.trim()) return "linkedin";
    return null;
  }

  /** Run one batch of the loop. The deterministic engine behind the cron and the manual trigger. */
  async runBatch(workspaceId: string): Promise<ReachRunResult> {
    const caps = this.deps.caps(workspaceId);
    const empty = (status: ReachRunStatus, reason: string): ReachRunResult => ({
      status,
      reason,
      prospectsFound: 0,
      messagesSent: 0,
      messagesQueued: 0,
      suppressed: 0,
      rateLimited: 0,
      skipped: 0,
      outcomes: [],
      tuning: null,
    });

    if (!caps.enabled) {
      await this.deps.runs.insert({
        workspaceId,
        sourceKind: caps.prospectSource,
        status: "skipped",
        prospectsFound: 0,
        messagesSent: 0,
        messagesQueued: 0,
        suppressedCount: 0,
        rateLimitedCount: 0,
        tuningReport: null,
      });
      return empty("skipped", "reach disabled for this workspace");
    }

    const now = this.now();
    const nowMs = now.getTime();
    const tuning = (await this.deps.runs.latestTuning(workspaceId)) ?? REACH_TUNING_DEFAULTS;

    // Step 1 — learn the ICP, applying the tuned signal priority.
    const seed = await this.deps.icp.seed(workspaceId);
    const icp = deriveIcp({ ...seed, prioritySignals: tuning.signalPriority });

    // Step 2 — source prospects. Money-gate a PAID source BEFORE the call (buying data is the money action).
    const source = this.deps.resolveSource(workspaceId, caps.prospectSource);
    if (source.paid) {
      const estCents = source.estimateCostCents(caps.batchSize);
      if (estCents > 0) {
        const spend = await this.deps.approvals.dataCreditSpend(workspaceId, source.kind);
        if (spend.pendingRequestId) {
          await this.deps.runs.insert({
            workspaceId,
            sourceKind: source.kind,
            status: "awaiting_data_funding",
            prospectsFound: 0,
            messagesSent: 0,
            messagesQueued: 0,
            suppressedCount: 0,
            rateLimitedCount: 0,
            tuningReport: null,
          });
          return {
            ...empty("awaiting_data_funding", "paid data spend already awaiting owner approval"),
            approvalRequestId: spend.pendingRequestId,
          };
        }
        const projectedSpend = spend.pendingCents + spend.approvedCents + estCents;
        if (projectedSpend > caps.dataCreditBudgetCents) {
          await this.deps.runs.insert({
            workspaceId,
            sourceKind: source.kind,
            status: "skipped",
            prospectsFound: 0,
            messagesSent: 0,
            messagesQueued: 0,
            suppressedCount: 0,
            rateLimitedCount: 0,
            tuningReport: null,
          });
          return empty(
            "skipped",
            `paid data credit budget exceeded (${projectedSpend}/${caps.dataCreditBudgetCents} cents)`,
          );
        }
        const { requestId } = await this.deps.approvals.submitDataCreditSpend({
          workspaceId,
          provider: source.kind,
          amountCents: estCents,
          prospectCount: caps.batchSize,
          summary: `Reach: buy ~${caps.batchSize} ${source.kind} prospects ($${(estCents / 100).toFixed(2)})`,
        });
        await this.deps.runs.insert({
          workspaceId,
          sourceKind: source.kind,
          status: "awaiting_data_funding",
          prospectsFound: 0,
          messagesSent: 0,
          messagesQueued: 0,
          suppressedCount: 0,
          rateLimitedCount: 0,
          tuningReport: null,
        });
        return {
          ...empty("awaiting_data_funding", "paid data spend awaiting owner approval"),
          approvalRequestId: requestId,
        };
      }
    }

    const contacted = await this.deps.contacts.contactedKeys(workspaceId);
    let prospects;
    try {
      const result = await source.search({ icp, limit: caps.batchSize, excludeKeys: contacted });
      prospects = result.prospects;
    } catch (err) {
      if (err instanceof ProspectSourceUnavailableError) {
        this.deps.log?.warn(
          { workspaceId, source: source.kind },
          "reach: prospect source unavailable",
        );
        await this.deps.runs.insert({
          workspaceId,
          sourceKind: source.kind,
          status: "skipped",
          prospectsFound: 0,
          messagesSent: 0,
          messagesQueued: 0,
          suppressedCount: 0,
          rateLimitedCount: 0,
          tuningReport: null,
        });
        return empty("skipped", `prospect source unavailable: ${err.message}`);
      }
      throw err;
    }

    // Step 3 — score + dedupe + rank.
    const ranked = rankBatch(prospects, icp, contacted, nowMs, caps.batchSize);

    const since24h = new Date(nowMs - DAY_MS);
    const suppressed = await this.deps.suppressions.loadSuppressed(workspaceId);
    const healthWindowStart = new Date(nowMs - TUNING_WINDOW_MS);
    const [healthSendData, healthReceiptData] = await Promise.all([
      this.deps.sends.sendsSince(workspaceId, healthWindowStart),
      this.deps.receipts.receiptData(workspaceId, healthWindowStart),
    ]);
    const health = computeMetrics({
      prospectsFound: healthSendData.length,
      sends: healthSendData,
      receipts: healthReceiptData,
    });
    const legacySentToday = await this.deps.sends.countSentSince(workspaceId, since24h);
    const legacyPauseReason = domainPauseReason({
      sent: health.sent,
      bounceRate: health.bounceRate,
      complaintRate: health.complaintRate,
      maxBounceRate: caps.maxBounceRate,
      maxComplaintRate: caps.maxComplaintRate,
    });
    const configuredDomains: ReachSendingDomain[] = caps.sendingDomains.filter((d) => d.enabled);
    const domainStates: DomainState[] = configuredDomains.length
      ? await Promise.all(
          configuredDomains.map(async (d) => {
            const sentToday = await this.deps.sends.countSentSince(workspaceId, since24h, d.domain);
            const domainSends = healthSendData.filter((s) => s.sendingDomain === d.domain);
            const domainHealth = computeMetrics({
              prospectsFound: domainSends.length,
              sends: domainSends,
              receipts: healthReceiptData.filter((r) => r.sendingDomain === d.domain),
            });
            return {
              from: d.from,
              domain: d.domain,
              dailyCap: d.dailyCap,
              sentToday,
              effectiveDailyCap: warmupDailyCap(domainHealth.sent, d.dailyCap),
              pauseReason: domainPauseReason({
                sent: domainHealth.sent,
                bounceRate: domainHealth.bounceRate,
                complaintRate: domainHealth.complaintRate,
                maxBounceRate: caps.maxBounceRate,
                maxComplaintRate: caps.maxComplaintRate,
              }),
            };
          }),
        )
      : [
          legacyDomainState({
            sentToday: legacySentToday,
            effectiveDailyCap: warmupDailyCap(health.sent, caps.perDomainDailyCap),
            dailyCap: caps.perDomainDailyCap,
            pauseReason: legacyPauseReason,
          }),
        ];
    const footerInfo = {
      brandName: caps.brandName ?? undefined,
      postalAddress: caps.postalAddress ?? undefined,
      unsubscribeUrl: caps.unsubscribeUrl ?? undefined,
    };

    const outcomes: ReachOutcome[] = [];
    let messagesSent = 0;
    let messagesQueued = 0;
    let suppressedCount = 0;
    let rateLimitedCount = 0;
    let skippedCount = 0;

    /** Send a composed message, record the attempt, and (on a real touch) advance/enrol the cadence. */
    const dispatch = async (
      message: ReturnType<typeof personalizeOpener>,
      channel: ReachChannel,
      enrollment: CadenceEnrollment,
      score: number,
    ): Promise<void> => {
      if (channel === "email" && !isPlausibleEmail(message.toAddress.trim())) {
        await this.deps.sends.insert({
          workspaceId,
          contactKey: message.contactKey,
          channel,
          status: "skipped",
          variant: message.variant,
          signalKind: message.signalKind,
          subject: message.subject,
          externalId: null,
          sentHourUtc: tuning.sendHourUtc,
          detail: "invalid email address",
        });
        skippedCount += 1;
        outcomes.push({ contactKey: message.contactKey, channel, status: "skipped" });
        return;
      }
      const selectedDomain = channel === "email" ? chooseDomain(domainStates) : null;
      const pausedDomains = domainStates.filter((s) => s.pauseReason);
      if (channel === "email" && !selectedDomain && pausedDomains.length === domainStates.length && pausedDomains[0]?.pauseReason) {
        await this.deps.sends.insert({
          workspaceId,
          contactKey: message.contactKey,
          channel,
          status: "rate_limited",
          variant: message.variant,
          signalKind: message.signalKind,
          subject: message.subject,
          externalId: null,
          sentHourUtc: tuning.sendHourUtc,
          sendingDomain: pausedDomains[0].domain,
          detail: "deliverability pause: " + pausedDomains[0].pauseReason,
        });
        rateLimitedCount += 1;
        outcomes.push({ contactKey: message.contactKey, channel, status: "rate_limited" });
        return;
      }
      if (channel === "email" && !selectedDomain) {
        const capped = domainStates
          .filter((s) => !s.pauseReason)
          .sort((a, b) => (b.effectiveDailyCap - b.sentToday) - (a.effectiveDailyCap - a.sentToday))[0] ?? domainStates[0];
        await this.deps.sends.insert({
          workspaceId,
          contactKey: message.contactKey,
          channel,
          status: "rate_limited",
          variant: message.variant,
          signalKind: message.signalKind,
          subject: "",
          externalId: null,
          sentHourUtc: tuning.sendHourUtc,
          sendingDomain: capped?.domain ?? null,
          detail:
            capped && capped.effectiveDailyCap < capped.dailyCap
              ? "per-domain warmup cap (" + capped.effectiveDailyCap + "/" + capped.dailyCap + ") reached"
              : `per-domain daily cap (${capped?.dailyCap ?? caps.perDomainDailyCap}) reached`,
        });
        rateLimitedCount += 1;
        outcomes.push({ contactKey: message.contactKey, channel, status: "rate_limited" });
        return;
      }
      const deliverability =
        channel === "email" ? ((await this.deps.deliverability?.proof(workspaceId)) ?? null) : null;
      const spamRisk = checkSpamRisk({ subject: message.subject, body: message.body });
      const outcome = await this.deps.channels[channel].send(message, {
        workspaceId,
        suppressed,
        footerInfo,
        deliverability,
        from: selectedDomain?.from ?? null,
        sendingDomain: selectedDomain?.domain ?? null,
      });
      await this.deps.sends.insert({
        workspaceId,
        contactKey: message.contactKey,
        channel,
        status: outcome.status,
        variant: message.variant,
        signalKind: message.signalKind,
        subject: message.subject,
        externalId: outcome.externalId,
        sentHourUtc: tuning.sendHourUtc,
        sendingDomain: selectedDomain?.domain ?? null,
        detail: appendAuditDetail(outcome.detail, {
          spamRisk,
          ...(selectedDomain?.domain ? { sendingDomain: selectedDomain.domain } : {}),
        }),
      });
      outcomes.push({ contactKey: message.contactKey, channel, status: outcome.status });
      if (outcome.status === "sent") {
        messagesSent += 1;
        if (selectedDomain) selectedDomain.sentToday += 1;
      } else if (outcome.status === "queued") messagesQueued += 1;
      else if (outcome.status === "suppressed") suppressedCount += 1;
      else if (outcome.status === "skipped" || outcome.status === "failed") skippedCount += 1;

      // Enrol (or advance) the cadence only for a message that actually went out or queued.
      if (outcome.status === "sent" || outcome.status === "queued") {
        await this.deps.contacts.upsertEnrollment({
          workspaceId,
          contactKey: message.contactKey,
          recipientLabel: message.recipientLabel,
          channel,
          enrollment: advanceEnrollment(enrollment, DEFAULT_CADENCE, nowMs),
          score,
          signalKind: message.signalKind,
        });
      }
    };

    // Step 6 (continued) — process DUE cadence FOLLOW-UPS for already-enrolled prospects (touches 2+).
    // Without this the cadence would only ever send the opener; here a due step is composed as a short
    // on-angle nudge and sent under the same per-domain cap + suppression.
    for (const e of await this.deps.contacts.activeEnrollments(workspaceId)) {
      const enrollment: CadenceEnrollment = {
        contactKey: e.contactKey,
        currentStep: e.currentStep,
        lastStepAtMs: e.lastStepAtMs,
        status: "active",
      };
      const step = nextDueStep(enrollment, DEFAULT_CADENCE, nowMs);
      if (!step) continue;
      const followUp = composeFollowUp({
        contactKey: e.contactKey,
        recipientLabel: e.recipientLabel,
        channel: e.channel,
        variant: step.variant,
        step: step.stepIndex,
        brandName: caps.brandName ?? "the team",
      });
      if (!followUp) {
        skippedCount += 1;
        continue;
      }
      // Carry the original signal kind forward (the follow-up itself references no signal).
      await dispatch(
        { ...followUp, signalKind: e.signalKind as ReachMessage["signalKind"] },
        e.channel,
        enrollment,
        e.score,
      );
    }

    for (const scored of ranked) {
      const channel = this.channelFor(scored.prospect.email, scored.prospect.linkedinUrl);
      if (!channel) {
        skippedCount += 1;
        continue;
      }
      // Step 4 — personalise the 1:1 opener around the freshest signal, in the tuned angle. Step 5/6 (send
      // under cap + suppression, then enrol at step 1) happen in `dispatch`.
      const message = personalizeOpener({
        scored,
        icp,
        channel,
        variant: tuning.variant,
        brandName: caps.brandName ?? "the team",
      });
      await dispatch(message, channel, newEnrollment(scored.contactKey), scored.score);
    }

    // Steps 7 + 8 — measure the trailing window and self-tune the NEXT batch.
    const windowStart = new Date(nowMs - TUNING_WINDOW_MS);
    const [sendData, receiptData] = await Promise.all([
      this.deps.sends.sendsSince(workspaceId, windowStart),
      this.deps.receipts.receiptData(workspaceId, windowStart),
    ]);
    const metrics = computeMetrics({
      prospectsFound: ranked.length,
      sends: sendData,
      receipts: receiptData,
    });
    const tuningReport = tuneNextBatch(metrics, tuning);

    await this.deps.runs.insert({
      workspaceId,
      sourceKind: source.kind,
      status: "completed",
      prospectsFound: ranked.length,
      messagesSent,
      messagesQueued,
      suppressedCount,
      rateLimitedCount,
      tuningReport: tuningReport as unknown as Record<string, unknown>,
    });

    return {
      status: "completed",
      reason: "ok",
      prospectsFound: ranked.length,
      messagesSent,
      messagesQueued,
      suppressed: suppressedCount,
      rateLimited: rateLimitedCount,
      skipped: skippedCount,
      outcomes,
      tuning: tuningReport,
    };
  }

  /**
   * Record an external engagement receipt (open/reply/booked). Idempotent. A reply stops the prospect's
   * cadence (we don't keep poking someone who answered). Returns whether a new receipt was written.
   */
  async recordReceipt(
    workspaceId: string,
    input: {
      contactKey: string;
      kind: ReachReceiptKind;
      externalRef: string;
      occurredAt?: Date;
      replyBody?: string | null;
      replyFrom?: string | null;
      replySubject?: string | null;
    },
  ): Promise<{ recorded: boolean }> {
    if (!input.externalRef.trim()) {
      return { recorded: false };
    }
    const sendId = await this.deps.sends.latestSendId(workspaceId, input.contactKey);
    if (!sendId) return { recorded: false };
    const res = await this.deps.receipts.record({
      workspaceId,
      sendId,
      contactKey: input.contactKey,
      kind: input.kind,
      externalRef: input.externalRef.trim(),
      replyBody: input.replyBody ?? null,
      replyFrom: input.replyFrom ?? null,
      replySubject: input.replySubject ?? null,
      occurredAt: input.occurredAt ?? this.now(),
    });
    if (res.recorded && input.kind === "reply") {
      await this.deps.contacts.markStatus(workspaceId, input.contactKey, "replied");
    }
    return res;
  }

  async recordInboundReply(
    workspaceId: string,
    input: {
      externalRef: string;
      inReplyTo?: string | null;
      contactKey?: string | null;
      replyBody?: string | null;
      replyFrom?: string | null;
      replySubject?: string | null;
      occurredAt?: Date;
    },
  ): Promise<{ matched: boolean; recorded: boolean; contactKey?: string }> {
    const externalRef = input.externalRef.trim();
    if (!externalRef) return { matched: false, recorded: false };
    let contactKey = input.contactKey?.trim() || null;
    if (!contactKey && input.inReplyTo && this.deps.sends.findByExternalId) {
      const send = await this.deps.sends.findByExternalId(workspaceId, input.inReplyTo.trim());
      contactKey = send?.contactKey ?? null;
    }
    if (!contactKey) return { matched: false, recorded: false };
    const result = await this.recordReceipt(workspaceId, {
      contactKey,
      kind: "reply",
      externalRef,
      replyBody: input.replyBody,
      replyFrom: input.replyFrom,
      replySubject: input.replySubject,
      occurredAt: input.occurredAt,
    });
    return { matched: true, recorded: result.recorded, contactKey };
  }

  async replyThreads(workspaceId: string, limit = 50): Promise<ReachReplyThread[]> {
    return this.deps.receipts.replyThreads?.(workspaceId, limit) ?? [];
  }

  /** Full metrics over a trailing window (default 30d) for the console / proof tile. */
  async metrics(workspaceId: string, windowMs: number = TUNING_WINDOW_MS): Promise<ReachMetrics> {
    const since = new Date(this.now().getTime() - windowMs);
    const [sendData, receiptData] = await Promise.all([
      this.deps.sends.sendsSince(workspaceId, since),
      this.deps.receipts.receiptData(workspaceId, since),
    ]);
    const sent = sendData.filter((s) => s.status === "sent").length;
    return computeMetrics({ prospectsFound: sent, sends: sendData, receipts: receiptData });
  }

  /** The headline numbers for the founder-console Reach proof tile. */
  async summary(workspaceId: string, windowMs: number = TUNING_WINDOW_MS): Promise<ReachSummary> {
    const m = await this.metrics(workspaceId, windowMs);
    return {
      prospectsFound: m.contacted,
      messagesSent: m.sent,
      replies: m.replies,
      booked: m.booked,
    };
  }
}
