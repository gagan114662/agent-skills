import type { FastifyBaseLogger } from "fastify";
import type { ReachCaps } from "./caps.js";
import { DEFAULT_CADENCE, advanceEnrollment, newEnrollment, type CadenceEnrollment } from "./cadence.js";
import { deriveIcp, type IcpSeed } from "./icp.js";
import { computeMetrics, type ReachMetrics, type ReceiptDatum, type SendDatum } from "./measure.js";
import { personalizeOpener } from "./personalize.js";
import { ProspectSourceUnavailableError, type ProspectSource } from "./prospect-source.js";
import { rankBatch } from "./score.js";
import { REACH_TUNING_DEFAULTS, tuneNextBatch, type ReachTuningConfig, type TuningReport } from "./self-tune.js";
import type { ReachChannelAdapter } from "./channel.js";
import type {
  ProspectSourceKind,
  ReachChannel,
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

export interface ReachContactStore {
  /** Every contact_key we've already enrolled (the dedupe set — never re-touch last week's list). */
  contactedKeys(workspaceId: string): Promise<Set<string>>;
  /** Create or advance a cadence enrolment. */
  upsertEnrollment(input: EnrollmentUpsert): Promise<void>;
  /** Mark a contact replied / opted_out (stops the cadence). */
  markStatus(workspaceId: string, contactKey: string, status: "replied" | "opted_out"): Promise<void>;
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
  detail: string;
}

export interface ReachSendStore {
  /** Count messages actually SENT since `since` (the per-sending-domain rate-cap denominator). */
  countSentSince(workspaceId: string, since: Date): Promise<number>;
  insert(input: SendInsert): Promise<{ id: string }>;
  /** The most recent send for a contact (to attach a receipt to). */
  latestSendId(workspaceId: string, contactKey: string): Promise<string | null>;
  /** Flattened sent rows since `since`, for measurement. */
  sendsSince(workspaceId: string, since: Date): Promise<SendDatum[]>;
}

export interface ReceiptInsert {
  workspaceId: string;
  sendId: string;
  contactKey: string;
  kind: ReachReceiptKind;
  externalRef: string;
  occurredAt: Date;
}

export interface ReachReceiptStore {
  /** Idempotent insert (returns false on a duplicate external receipt). */
  record(input: ReceiptInsert): Promise<{ recorded: boolean }>;
  /** Receipts since `since`, pre-attributed to the originating send's variant/signal/hour. */
  receiptData(workspaceId: string, since: Date): Promise<ReceiptDatum[]>;
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

export class ReachService {
  constructor(private readonly deps: ReachDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Pick the channel for a prospect: email when we have an address, else LinkedIn, else none. */
  private channelFor(email: string | null, linkedinUrl: string | null): ReachChannel | null {
    if (email && email.trim()) return "email";
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
        return { ...empty("awaiting_data_funding", "paid data spend awaiting owner approval"), approvalRequestId: requestId };
      }
    }

    const contacted = await this.deps.contacts.contactedKeys(workspaceId);
    let prospects;
    try {
      const result = await source.search({ icp, limit: caps.batchSize, excludeKeys: contacted });
      prospects = result.prospects;
    } catch (err) {
      if (err instanceof ProspectSourceUnavailableError) {
        this.deps.log?.warn({ workspaceId, source: source.kind }, "reach: prospect source unavailable");
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

    // Per-domain rate cap: how many more emails may leave the sending domain today.
    const since24h = new Date(nowMs - DAY_MS);
    const sentToday = await this.deps.sends.countSentSince(workspaceId, since24h);
    let emailHeadroom = Math.max(0, caps.perDomainDailyCap - sentToday);

    const suppressed = await this.deps.suppressions.loadSuppressed(workspaceId);
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

    for (const scored of ranked) {
      const channel = this.channelFor(scored.prospect.email, scored.prospect.linkedinUrl);
      if (!channel) {
        skippedCount += 1;
        continue;
      }

      // Step 5a — per-domain rate cap on the live (email) channel, applied BEFORE the adapter is called.
      if (channel === "email" && emailHeadroom <= 0) {
        await this.deps.sends.insert({
          workspaceId,
          contactKey: scored.contactKey,
          channel,
          status: "rate_limited",
          variant: tuning.variant,
          signalKind: scored.freshSignal?.kind ?? null,
          subject: "",
          externalId: null,
          sentHourUtc: tuning.sendHourUtc,
          detail: `per-domain daily cap (${caps.perDomainDailyCap}) reached`,
        });
        rateLimitedCount += 1;
        outcomes.push({ contactKey: scored.contactKey, channel, status: "rate_limited" });
        continue;
      }

      // Step 4 — personalise the 1:1 opener around the freshest signal, in the tuned angle.
      const message = personalizeOpener({
        scored,
        icp,
        channel,
        variant: tuning.variant,
        brandName: caps.brandName ?? "the team",
      });

      // Step 5b — send under suppression + compliance (the adapter enforces both).
      const outcome = await this.deps.channels[channel].send(message, { suppressed, footerInfo });

      await this.deps.sends.insert({
        workspaceId,
        contactKey: scored.contactKey,
        channel,
        status: outcome.status,
        variant: message.variant,
        signalKind: message.signalKind,
        subject: message.subject,
        externalId: outcome.externalId,
        sentHourUtc: tuning.sendHourUtc,
        detail: outcome.detail,
      });

      outcomes.push({ contactKey: scored.contactKey, channel, status: outcome.status });
      if (outcome.status === "sent") {
        messagesSent += 1;
        if (channel === "email") emailHeadroom -= 1;
      } else if (outcome.status === "queued") messagesQueued += 1;
      else if (outcome.status === "suppressed") suppressedCount += 1;
      else if (outcome.status === "skipped" || outcome.status === "failed") skippedCount += 1;

      // Step 6 — enrol (or advance) the cadence only for a message that actually went out or queued.
      if (outcome.status === "sent" || outcome.status === "queued") {
        const enrolled = advanceEnrollment(newEnrollment(scored.contactKey), DEFAULT_CADENCE, nowMs);
        await this.deps.contacts.upsertEnrollment({
          workspaceId,
          contactKey: scored.contactKey,
          recipientLabel: message.recipientLabel,
          channel,
          enrollment: enrolled,
          score: scored.score,
          signalKind: message.signalKind,
        });
      }
    }

    // Steps 7 + 8 — measure the trailing window and self-tune the NEXT batch.
    const windowStart = new Date(nowMs - TUNING_WINDOW_MS);
    const [sendData, receiptData] = await Promise.all([
      this.deps.sends.sendsSince(workspaceId, windowStart),
      this.deps.receipts.receiptData(workspaceId, windowStart),
    ]);
    const metrics = computeMetrics({ prospectsFound: ranked.length, sends: sendData, receipts: receiptData });
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
    input: { contactKey: string; kind: ReachReceiptKind; externalRef: string; occurredAt?: Date },
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
      occurredAt: input.occurredAt ?? this.now(),
    });
    if (res.recorded && input.kind === "reply") {
      await this.deps.contacts.markStatus(workspaceId, input.contactKey, "replied");
    }
    return res;
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
    return { prospectsFound: m.contacted, messagesSent: m.sent, replies: m.replies, booked: m.booked };
  }
}
