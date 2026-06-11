/**
 * CustomerVoiceService (#114, ADR-0114) — the IO orchestrator for the post-launch support / feedback /
 * churn loop, modelled on the #101 DemandValidationService: side effects here, the pure
 * classify/metrics/digest/scorecard logic in the sibling modules. Every collaborator is an injected seam
 * so the loop is unit-tested over fakes (no DB, no agent spend, no network); `default.ts` wires production.
 *
 * The loop is **inbound-only**: a signed webhook turns a customer message into a ticket + a classified
 * `user_voice` insight (the evidence row), the metrics feed the #96 scorecard / #104 console / #107
 * portfolio, and the ONLY outbound path — a reply — is a #13 sensitive-by-default `external.send` that a
 * human approves. An agent never sends a reply autonomously (v1).
 */
import { classifyFeedback, type ChurnRisk, type Sentiment, type VoiceCategory, type VoiceSourceKind } from "./classify.js";
import { aggregateVoiceMetrics, type VoiceMetrics } from "./metrics.js";
import { buildVoiceDigest, type VoiceDigest } from "./digest.js";
import { buildVoiceReply } from "./reply.js";
import type { VoiceEvidence } from "./scorecard-evidence.js";
import type { VoiceCaps } from "./caps.js";

export type TicketStatus = "open" | "triaged" | "awaiting_approval" | "replied" | "closed";

export interface SupportTicket {
  id: string;
  workspaceId: string;
  ventureIdeaId: string | null;
  channel: string;
  sourceRef: string;
  contact: string | null;
  subject: string | null;
  body: string;
  sentiment: Sentiment | null;
  churnRisk: ChurnRisk | null;
  category: VoiceCategory | null;
  status: TicketStatus;
  draftReply: string | null;
  replyApprovalRequestId: string | null;
  triageSessionId: string | null;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VoiceInsight {
  id: string;
  workspaceId: string;
  ventureIdeaId: string | null;
  ticketId: string | null;
  kind: "user_voice";
  sourceKind: VoiceSourceKind;
  sentiment: Sentiment;
  churnRisk: ChurnRisk;
  category: string;
  npsScore: number | null;
  summary: string;
  sourceRef: string | null;
  createdAt: Date;
}

export interface CreateTicketInput {
  workspaceId: string;
  ventureIdeaId: string | null;
  channel: string;
  sourceRef: string;
  contact: string | null;
  subject: string | null;
  body: string;
  sentiment: Sentiment;
  churnRisk: ChurnRisk;
  category: VoiceCategory;
  status: TicketStatus;
  createdByMemberId: string | null;
}

export interface TicketPatch {
  status?: TicketStatus;
  draftReply?: string | null;
  replyApprovalRequestId?: string | null;
  triageSessionId?: string | null;
  sentiment?: Sentiment;
  churnRisk?: ChurnRisk;
  category?: VoiceCategory;
}

/** Persistence seam for support tickets. `create` is idempotent on `(workspace, channel, sourceRef)`. */
export interface TicketStore {
  create(input: CreateTicketInput): Promise<{ ticket: SupportTicket; deduped: boolean }>;
  get(workspaceId: string, id: string): Promise<SupportTicket | undefined>;
  list(workspaceId: string, opts?: { needsHuman?: boolean }): Promise<SupportTicket[]>;
  update(workspaceId: string, id: string, patch: TicketPatch): Promise<SupportTicket | undefined>;
}

export interface CreateInsightInput {
  workspaceId: string;
  ventureIdeaId: string | null;
  ticketId: string | null;
  sourceKind: VoiceSourceKind;
  sentiment: Sentiment;
  churnRisk: ChurnRisk;
  category: string;
  npsScore: number | null;
  summary: string;
  sourceRef: string | null;
}

/** Persistence seam for `voice_insight` evidence rows. `create` dedupes on `(workspace, sourceKind, sourceRef)`. */
export interface InsightStore {
  create(input: CreateInsightInput): Promise<{ insight: VoiceInsight; deduped: boolean }>;
  /** List insights, optionally scoped to one idea and/or to those created at/after `createdAfter`. */
  list(workspaceId: string, opts?: { ventureIdeaId?: string; createdAfter?: Date }): Promise<VoiceInsight[]>;
  listForIdea(workspaceId: string, ventureIdeaId: string): Promise<VoiceInsight[]>;
}

/** The #13 gate seam: an outbound reply becomes a PENDING approval request (sensitive-by-default). */
export interface ReplyGate {
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    actionType: string;
    payload: Record<string, unknown>;
    amount: number | null;
    summary: string;
  }): Promise<{ id: string }>;
}

/** The #59 triage-agent seam: draft a reply for a ticket. Returns null when no agent is available. */
export interface TriageAgent {
  draft(input: {
    workspaceId: string;
    memberId: string | null;
    ticketId: string;
    subject: string | null;
    body: string;
    sentiment: Sentiment;
    churnRisk: ChurnRisk;
    category: VoiceCategory;
  }): Promise<{ sessionId: string; draftReply: string } | null>;
}

/** Tenant-scoped venture-idea ownership lookup (the #19 IDOR boundary). */
export interface VentureLookup {
  exists(workspaceId: string, ventureIdeaId: string): Promise<boolean>;
}

export interface CustomerVoiceServiceDeps {
  tickets: TicketStore;
  insights: InsightStore;
  gate: ReplyGate;
  /** Optional triage agent (#59). Absent ⇒ no proactive draft (the safe default: ticket lands open). */
  triage?: TriageAgent;
  ventures: VentureLookup;
  /** The #17 kill switch — when engaged, no proactive triage draft is started. Default: off. */
  killSwitch?: (workspaceId: string) => Promise<boolean>;
  /** Resolved voice policy for the workspace (#58). */
  caps: (workspaceId: string) => VoiceCaps;
  /** Per-workspace inbound webhook secret (resolved from config/secrets); null ⇒ webhook disabled (503). */
  webhookSecret?: (workspaceId: string) => Promise<string | null>;
  now?: () => Date;
}

/** Thrown when a ticket (or its prerequisite venture idea) does not exist for the workspace → route 404. */
export class VoiceNotFoundError extends Error {
  constructor(message = "voice ticket not found") {
    super(message);
    this.name = "VoiceNotFoundError";
  }
}

/** Thrown when an operation is invalid for the ticket's lifecycle state → route 409. */
export class VoiceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceStateError";
  }
}

export interface IngestTicketInput {
  workspaceId: string;
  channel: string;
  sourceRef: string;
  body: string;
  subject?: string | null;
  contact?: string | null;
  ventureIdeaId?: string | null;
  createdByMemberId?: string | null;
}

export interface IngestFeedbackInput {
  workspaceId: string;
  sourceKind: Exclude<VoiceSourceKind, "support_ticket">;
  sourceRef: string;
  text?: string;
  npsScore?: number | null;
  ventureIdeaId?: string | null;
}

function summarize(text: string, max = 200): string {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export class CustomerVoiceService {
  constructor(private readonly deps: CustomerVoiceServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async assertVenture(workspaceId: string, ventureIdeaId: string | null | undefined): Promise<string | null> {
    if (ventureIdeaId === undefined || ventureIdeaId === null) return null;
    if (!(await this.deps.ventures.exists(workspaceId, ventureIdeaId))) {
      throw new VoiceNotFoundError("venture idea not found in this workspace");
    }
    return ventureIdeaId;
  }

  /** Resolve the inbound webhook secret for the workspace (null ⇒ the webhook is disabled). */
  async webhookSecret(workspaceId: string): Promise<string | null> {
    return this.deps.webhookSecret ? this.deps.webhookSecret(workspaceId) : null;
  }

  /**
   * Ingest an inbound support message: classify it, persist the ticket + a `user_voice` insight, and —
   * only when the workspace opted into proactive triage (and the kill switch is off) — let the triage
   * agent DRAFT a reply (never send it). Idempotent on `(workspace, channel, sourceRef)`.
   */
  async ingestTicket(input: IngestTicketInput): Promise<{ ticket: SupportTicket; insight: VoiceInsight; deduped: boolean }> {
    const ventureIdeaId = await this.assertVenture(input.workspaceId, input.ventureIdeaId);
    const classification = classifyFeedback({ sourceKind: "support_ticket", text: input.body });

    const { ticket, deduped } = await this.deps.tickets.create({
      workspaceId: input.workspaceId,
      ventureIdeaId,
      channel: input.channel,
      sourceRef: input.sourceRef,
      contact: input.contact ?? null,
      subject: input.subject ?? null,
      body: input.body,
      sentiment: classification.sentiment,
      churnRisk: classification.churnRisk,
      category: classification.category,
      status: "triaged",
      createdByMemberId: input.createdByMemberId ?? null,
    });

    const { insight } = await this.deps.insights.create({
      workspaceId: input.workspaceId,
      ventureIdeaId,
      ticketId: ticket.id,
      sourceKind: "support_ticket",
      sentiment: classification.sentiment,
      churnRisk: classification.churnRisk,
      category: classification.category,
      npsScore: null,
      summary: summarize(input.subject ? `${input.subject}: ${input.body}` : input.body),
      sourceRef: input.sourceRef,
    });

    let current = ticket;
    if (!deduped) {
      const caps = this.deps.caps(input.workspaceId);
      const killed = this.deps.killSwitch ? await this.deps.killSwitch(input.workspaceId) : false;
      if (caps.enabled && caps.autoTriageDraft && this.deps.triage && !killed) {
        const drafted = await this.deps.triage.draft({
          workspaceId: input.workspaceId,
          memberId: input.createdByMemberId ?? null,
          ticketId: ticket.id,
          subject: input.subject ?? null,
          body: input.body,
          sentiment: classification.sentiment,
          churnRisk: classification.churnRisk,
          category: classification.category,
        });
        if (drafted) {
          current =
            (await this.deps.tickets.update(input.workspaceId, ticket.id, {
              draftReply: drafted.draftReply,
              triageSessionId: drafted.sessionId,
            })) ?? ticket;
        }
      }
    }

    return { ticket: current, insight, deduped };
  }

  /** Ingest a non-ticket feedback signal (checkout abandon / cancellation / NPS) → a classified insight. */
  async ingestFeedback(input: IngestFeedbackInput): Promise<{ insight: VoiceInsight; deduped: boolean }> {
    const ventureIdeaId = await this.assertVenture(input.workspaceId, input.ventureIdeaId);
    const classification = classifyFeedback({ sourceKind: input.sourceKind, text: input.text ?? "", npsScore: input.npsScore });
    return this.deps.insights.create({
      workspaceId: input.workspaceId,
      ventureIdeaId,
      ticketId: null,
      sourceKind: input.sourceKind,
      sentiment: classification.sentiment,
      churnRisk: classification.churnRisk,
      category: classification.category,
      npsScore: typeof input.npsScore === "number" ? input.npsScore : null,
      summary: summarize(input.text ?? `${input.sourceKind} signal`),
      sourceRef: input.sourceRef,
    });
  }

  /**
   * Submit a reply for human approval. Builds the #13 `external.send` descriptor (sensitive-by-default),
   * enqueues it as a PENDING request, and moves the ticket to `awaiting_approval`. **Never sends** — the
   * recorded-only #13 executor runs the send after a human approves (v1: a human approves every reply).
   */
  async submitReply(
    workspaceId: string,
    ticketId: string,
    memberId: string,
    replyBody: string,
  ): Promise<{ approvalRequestId: string; status: TicketStatus }> {
    const ticket = await this.deps.tickets.get(workspaceId, ticketId);
    if (!ticket) throw new VoiceNotFoundError();
    // A ticket already awaiting approval has a PENDING #13 request; submitting again would overwrite
    // `replyApprovalRequestId` and orphan that request forever (approvals never expire). Block it — the
    // human must resolve (approve/reject) the outstanding request before another reply is drafted.
    if (ticket.status === "awaiting_approval" || ticket.status === "replied" || ticket.status === "closed") {
      throw new VoiceStateError(`ticket is ${ticket.status} — cannot submit a new reply`);
    }
    const descriptor = buildVoiceReply({ summary: summarize(replyBody, 120), target: ticket.contact ?? undefined });
    const req = await this.deps.gate.submit({
      workspaceId,
      requesterMemberId: memberId,
      actionType: descriptor.actionType,
      payload: { ...descriptor.payload, ticketId },
      amount: descriptor.amount,
      summary: `Reply to support ticket ${ticketId}: ${summarize(replyBody, 80)}`,
    });
    await this.deps.tickets.update(workspaceId, ticketId, {
      status: "awaiting_approval",
      replyApprovalRequestId: req.id,
      draftReply: replyBody,
    });
    return { approvalRequestId: req.id, status: "awaiting_approval" };
  }

  async get(workspaceId: string, ticketId: string): Promise<SupportTicket> {
    const ticket = await this.deps.tickets.get(workspaceId, ticketId);
    if (!ticket) throw new VoiceNotFoundError();
    return ticket;
  }

  async list(workspaceId: string, opts?: { needsHuman?: boolean }): Promise<SupportTicket[]> {
    return this.deps.tickets.list(workspaceId, opts);
  }

  /** Tickets not yet replied/closed — the inbox that still needs a human (the #104 attention list). */
  async needingHuman(workspaceId: string): Promise<SupportTicket[]> {
    return this.deps.tickets.list(workspaceId, { needsHuman: true });
  }

  /** The churn/NPS roll-up over the workspace's insights (optionally scoped to one venture idea). */
  async metrics(workspaceId: string, ventureIdeaId?: string): Promise<VoiceMetrics> {
    const insights = await this.deps.insights.list(workspaceId, { ventureIdeaId });
    return aggregateVoiceMetrics(insights);
  }

  /** The weekly voice-of-customer digest: metrics over the configured window + the human-attention count.
   * The window is filtered in the store (createdAfter) so the digest never loads the full history. */
  async digest(workspaceId: string): Promise<VoiceDigest> {
    const caps = this.deps.caps(workspaceId);
    const windowDays = caps.digestWindowDays;
    const createdAfter = new Date(this.now().getTime() - windowDays * 24 * 60 * 60 * 1000);
    const windowed = await this.deps.insights.list(workspaceId, { createdAfter });
    const metrics = aggregateVoiceMetrics(windowed);
    const needingHuman = await this.needingHuman(workspaceId);
    return buildVoiceDigest({ windowDays, metrics, ticketsNeedingHuman: needingHuman.length });
  }

  /** The #96 ↔ #114 source: an idea's customer-voice evidence, reduced for the scorecard overlay. */
  async userVoiceEvidence(workspaceId: string, ventureIdeaId: string): Promise<VoiceEvidence[]> {
    const insights = await this.deps.insights.listForIdea(workspaceId, ventureIdeaId);
    return insights.map((i) => ({ sentiment: i.sentiment, churnRisk: i.churnRisk, npsScore: i.npsScore }));
  }
}

/** The #96 ↔ #114 seam type the VentureService consumes for the voice overlay. */
export interface VoiceEvidenceSource {
  userVoiceEvidence(workspaceId: string, ideaId: string): Promise<VoiceEvidence[]>;
}
