/**
 * SupportDeskService (#190, ADR-0190) — the IO orchestrator for the bounded-autonomy support desk,
 * layered on the #114 Customer Voice inbox. Pure decision logic lives in the sibling modules
 * (`routing`/`escalation`/`kb`/`sla`/`recurrence`); this file does side effects only and every
 * collaborator is an injected seam, so the loop is unit-tested over fakes (no DB, no agent spend, no
 * network). `default.ts` wires production with the dangerous seams OFF.
 *
 * The whole design answers premortem #200: a customer-facing send is IRREVERSIBLE, so an autonomous reply
 * only happens when EVERY fence in `decideSupportRouting` passes AND an `AutoApprover` is wired (it is not,
 * by default). Even then the send rides the single #13 `external.send` path and is fully audited. A poisoned
 * inbound message can only raise the gate (escalate / money_queue), never lower it (§6). Refunds are never
 * autonomous (§4). Resolution metrics count external receipts only (§2).
 */
import type { IngestTicketInput, ReplyGate, SupportTicket, TicketStore } from "../voice/service.js";
import {
  buildAnswerWithReceipts,
  kbEntryFromResolvedTicket,
  kbSlug,
  type KbEntry,
  type NewKbEntry,
} from "./kb.js";
import { decideSupportRouting, type SupportRoute } from "./routing.js";
import { fingerprintComplaint } from "./recurrence.js";
import { buildRefundDraft, buildSupportReply } from "./reply.js";
import {
  computeResolutionMetrics,
  computeSlaBreaches,
  type ResolutionMetrics,
  type SlaBreach,
} from "./sla.js";
import type { SupportDeskCaps } from "./caps.js";

const COMPLAINT_CATEGORIES: ReadonlySet<string> = new Set(["bug", "churn", "pricing"]);
const DAY_MS = 24 * 60 * 60 * 1000;

function summarize(text: string, max = 200): string {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Persistence seam for KB entries. `upsert` dedupes on `(workspace, slug)`. */
export interface KbStore {
  list(workspaceId: string, opts?: { category?: string }): Promise<KbEntry[]>;
  get(workspaceId: string, id: string): Promise<KbEntry | undefined>;
  upsert(
    input: NewKbEntry & { createdByMemberId?: string | null },
  ): Promise<{ entry: KbEntry; deduped: boolean }>;
}

export interface CreateReceiptInput {
  workspaceId: string;
  ticketId: string | null;
  kind: string;
  providerRef: string;
  detail?: string | null;
  occurredAt?: Date;
}

export interface SupportReceipt {
  id: string;
  workspaceId: string;
  ticketId: string | null;
  kind: string;
  providerRef: string;
  detail: string | null;
  occurredAt: Date;
  createdAt: Date;
}

/** Persistence seam for external receipts + the auto-send audit marker. */
export interface ReceiptStore {
  create(input: CreateReceiptInput): Promise<{ receipt: SupportReceipt; deduped: boolean }>;
  /** Resolution-relevant receipts for the workspace (used by the pure metrics aggregator). */
  listForResolution(workspaceId: string): Promise<{ ticketId: string | null; kind: string }[]>;
  /** Customer-visible receipts for one ticket (delivery/reply/resolution status history). */
  listForTicket(workspaceId: string, ticketId: string): Promise<SupportReceipt[]>;
  /** Count receipts of a kind at/after `since` — backs the per-day auto-send cap. */
  countByKindSince(workspaceId: string, kind: string, since: Date): Promise<number>;
}

/**
 * The autonomous-send seam: approve + execute an already-enqueued #13 request through the SAME
 * `executeApprovedRequest` chokepoint a human uses. **Unset in the default wiring** — so out of the box an
 * `auto_send` route degrades to a pending human approval. Wiring this is the explicit opt-in to autonomy.
 */
export interface AutoApprover {
  approve(input: {
    workspaceId: string;
    approvalRequestId: string;
    memberId: string;
    reason: string;
  }): Promise<{ executed: boolean }>;
}

/** The recurring-complaint seam (#117/#171). Owns dedup/threshold/issue-filing; **no-op by default**. */
export interface ComplaintRecorder {
  record(input: {
    workspaceId: string;
    ventureIdeaId: string | null;
    signature: string;
    title: string;
    category: string;
    body: string;
  }): Promise<void>;
}

export interface SupportDeskServiceDeps {
  /** Inbound intake — reuses the #114 voice `ingestTicket` (classify + persist ticket + insight). */
  ingest(input: IngestTicketInput): Promise<{ ticket: SupportTicket; deduped: boolean }>;
  tickets: Pick<TicketStore, "get" | "list" | "update">;
  kb: KbStore;
  receipts: ReceiptStore;
  gate: ReplyGate;
  autoApprover?: AutoApprover;
  complaints?: ComplaintRecorder;
  /** Is this the owner workspace? Default: false (so `ownerWorkspaceOnly` blocks auto-send until wired). */
  ownerWorkspace?: (workspaceId: string) => Promise<boolean>;
  /**
   * The member an inbound-webhook-triggered triage attributes its #13 request to (the workspace owner —
   * the accountable human, the `requester_member_id` FK). Null ⇒ the webhook ingests but does not triage
   * (a ticket in an all-agent/owner-less workspace simply lands open for a human).
   */
  ownerMember?: (workspaceId: string) => Promise<string | null>;
  /** The #17 kill switch — when engaged, no autonomous send happens (degrades to approval). */
  killSwitch?: (workspaceId: string) => Promise<boolean>;
  caps: (workspaceId: string) => SupportDeskCaps;
  /** Per-workspace inbound webhook secret (widget + receipts). null ⇒ the route 503s (default-OFF). */
  webhookSecret?: (workspaceId: string) => Promise<string | null>;
  now?: () => Date;
}

export class SupportNotFoundError extends Error {
  constructor(message = "support resource not found") {
    super(message);
    this.name = "SupportNotFoundError";
  }
}

export interface TriageOutcome {
  ticket: SupportTicket;
  route: SupportRoute;
  reason: string;
  /** The #13 request this produced (external.send for a reply, billing.refund for money), if any. */
  approvalRequestId: string | null;
  /** True only when an autonomous send actually executed (route auto_send AND an AutoApprover was wired). */
  autoSent: boolean;
  /** The KB entry ids the draft cited (the receipts). Empty when the desk had no confident answer. */
  receipts: string[];
  escalationReasons: string[];
}

export interface ObjectionFaqDraft {
  signature: string;
  question: string;
  count: number;
  ticketIds: string[];
  kbEntryId: string;
  slug: string;
  deduped: boolean;
}

export interface ObjectionFaqRefresh {
  workspaceId: string;
  generatedAt: Date;
  minCount: number;
  drafts: ObjectionFaqDraft[];
}

export interface PublicTicketStatus {
  ticketId: string;
  status: SupportTicket["status"];
  subject: string | null;
  channel: string;
  createdAt: Date;
  updatedAt: Date;
  firstResponseSlaMinutes: number;
  slaDueAt: Date;
  slaBreached: boolean;
  responseState: "waiting" | "reply_pending_approval" | "replied" | "closed";
  events: { type: string; at: Date; detail: string | null }[];
}

export class SupportDeskService {
  constructor(private readonly deps: SupportDeskServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  async webhookSecret(workspaceId: string): Promise<string | null> {
    return this.deps.webhookSecret ? this.deps.webhookSecret(workspaceId) : null;
  }

  async publicTicketStatus(
    workspaceId: string,
    ticketId: string,
    sourceRef: string,
  ): Promise<PublicTicketStatus> {
    const ticket = await this.deps.tickets.get(workspaceId, ticketId);
    if (!ticket || ticket.sourceRef !== sourceRef)
      throw new SupportNotFoundError("ticket not found");
    const caps = this.deps.caps(workspaceId);
    const slaDueAt = new Date(ticket.createdAt.getTime() + caps.firstResponseSlaMinutes * 60_000);
    const responded = ticket.status === "replied" || ticket.status === "closed";
    const responseState =
      ticket.status === "closed"
        ? "closed"
        : ticket.status === "replied"
          ? "replied"
          : ticket.status === "awaiting_approval"
            ? "reply_pending_approval"
            : "waiting";
    const receipts = await this.deps.receipts.listForTicket(workspaceId, ticketId);
    return {
      ticketId: ticket.id,
      status: ticket.status,
      subject: ticket.subject,
      channel: ticket.channel,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      firstResponseSlaMinutes: caps.firstResponseSlaMinutes,
      slaDueAt,
      slaBreached: !responded && this.now().getTime() > slaDueAt.getTime(),
      responseState,
      events: [
        { type: "created", at: ticket.createdAt, detail: ticket.subject },
        ...(ticket.status !== "open"
          ? [
              {
                type: ticket.status,
                at: ticket.updatedAt,
                detail: ticket.draftReply ? "reply drafted" : null,
              },
            ]
          : []),
        ...receipts.map((receipt) => ({
          type: receipt.kind,
          at: receipt.occurredAt,
          detail: receipt.detail,
        })),
      ].sort((a, b) => a.at.getTime() - b.at.getTime()),
    };
  }

  /** Inbound intake → reuse #114 ingestion → triage the resulting ticket. Idempotent (dedupe in #114). */
  async intake(input: IngestTicketInput, memberId: string): Promise<TriageOutcome> {
    const { ticket } = await this.deps.ingest(input);
    return this.triageTicket(input.workspaceId, ticket.id, memberId);
  }

  /**
   * Inbound-webhook intake (the embeddable widget / email-forward hook). Ingests via #114, then triages
   * as the workspace owner — the accountable human the #13 request attributes to. When the workspace has
   * no owner member, the ticket lands open for a human (no triage), never an unattributed autonomous send.
   */
  async intakeWebhook(input: IngestTicketInput): Promise<TriageOutcome> {
    const { ticket } = await this.deps.ingest(input);
    const memberId = this.deps.ownerMember ? await this.deps.ownerMember(input.workspaceId) : null;
    if (!memberId) {
      return {
        ticket,
        route: "approval",
        reason: "no_owner_member",
        approvalRequestId: null,
        autoSent: false,
        receipts: [],
        escalationReasons: [],
      };
    }
    return this.triageTicket(input.workspaceId, ticket.id, memberId);
  }

  /**
   * Triage one ticket: build a KB-grounded answer, decide the route, and act. The ONLY place an
   * autonomous send can originate — and only through `decideSupportRouting`'s conjunction of fences plus a
   * wired `AutoApprover`. Idempotent-ish: a ticket already awaiting approval / replied / closed is left
   * untouched (re-triage must not orphan a pending #13 request).
   */
  async triageTicket(
    workspaceId: string,
    ticketId: string,
    memberId: string,
  ): Promise<TriageOutcome> {
    const ticket = await this.deps.tickets.get(workspaceId, ticketId);
    if (!ticket) throw new SupportNotFoundError("ticket not found");
    const caps = this.deps.caps(workspaceId);

    // A ticket with an outstanding/decided reply is left alone — re-triaging would orphan its #13 request.
    if (
      ticket.status === "awaiting_approval" ||
      ticket.status === "replied" ||
      ticket.status === "closed"
    ) {
      return {
        ticket,
        route: "approval",
        reason: `noop:${ticket.status}`,
        approvalRequestId: ticket.replyApprovalRequestId,
        autoSent: false,
        receipts: [],
        escalationReasons: [],
      };
    }

    // 1. Build the answer from the venture's OWN KB (never from the customer's text). The confidence the
    //    routing gate trusts comes from THIS — a question the KB can't answer scores low → escalate.
    const entries = await this.deps.kb.list(workspaceId);
    const answer = buildAnswerWithReceipts(entries, {
      subject: ticket.subject,
      body: ticket.body,
      category: ticket.category ?? "other",
    });

    // 2. Record a recurring-complaint signal (the recorder owns dedup/threshold/issue-filing; no-op default).
    await this.maybeRecordComplaint(ticket);

    // 3. The pure routing decision — over classification + a quarantined body scan, never instructions.
    const startOfDay = new Date(this.now().getTime() - DAY_MS);
    const autoSendsToday = await this.deps.receipts.countByKindSince(
      workspaceId,
      "auto_sent",
      startOfDay,
    );
    const isOwnerWorkspace = this.deps.ownerWorkspace
      ? await this.deps.ownerWorkspace(workspaceId)
      : false;
    const decision = decideSupportRouting({
      category: ticket.category ?? "other",
      sentiment: ticket.sentiment ?? "neutral",
      churnRisk: ticket.churnRisk ?? "low",
      body: ticket.body,
      kbConfidence: answer.confidence,
      isOwnerWorkspace,
      autoSendsToday,
      caps,
    });

    const base = { receipts: answer.receipts, escalationReasons: decision.escalation.reasons };

    switch (decision.route) {
      case "money_queue":
        return {
          ...(await this.toMoneyQueue(ticket, memberId)),
          route: "money_queue",
          reason: decision.reason,
          autoSent: false,
          ...base,
        };
      case "escalate":
        return {
          ...(await this.toEscalation(ticket, answer.draft)),
          route: "escalate",
          reason: decision.reason,
          autoSent: false,
          ...base,
        };
      case "auto_send":
        return {
          ...(await this.toReply(ticket, memberId, answer.draft, caps)),
          route: "auto_send",
          reason: decision.reason,
          ...base,
        };
      case "approval":
      default:
        return {
          ...(await this.toReply(ticket, memberId, answer.draft, caps, /* forceApproval */ true)),
          route: "approval",
          reason: decision.reason,
          autoSent: false,
          ...base,
        };
    }
  }

  /** Refund → a gated `billing.refund` draft in the MONEY queue. Never auto-executed. */
  private async toMoneyQueue(
    ticket: SupportTicket,
    memberId: string,
  ): Promise<{ ticket: SupportTicket; approvalRequestId: string }> {
    const descriptor = buildRefundDraft({
      summary: summarize(
        `Refund request from ticket ${ticket.id}: ${ticket.subject ?? ticket.body}`,
        120,
      ),
      amountCents: null,
      ticketId: ticket.id,
    });
    const req = await this.deps.gate.submit({
      workspaceId: ticket.workspaceId,
      requesterMemberId: memberId,
      actionType: descriptor.actionType,
      payload: { ...descriptor.payload },
      amount: descriptor.amount,
      summary: `MONEY: review refund for support ticket ${ticket.id}`,
    });
    const updated = await this.patch(ticket, {
      status: "awaiting_approval",
      replyApprovalRequestId: req.id,
      draftReply: `[refund request — routed to MONEY queue for human review]`,
    });
    return { ticket: updated, approvalRequestId: req.id };
  }

  /** Escalate → leave the ticket needing a human, with the KB draft attached for them. No send. */
  private async toEscalation(
    ticket: SupportTicket,
    draft: string,
  ): Promise<{ ticket: SupportTicket; approvalRequestId: null }> {
    const updated = await this.patch(ticket, {
      status: "triaged",
      draftReply: draft.length > 0 ? draft : null,
    });
    return { ticket: updated, approvalRequestId: null };
  }

  /**
   * Reply path. Always enqueues a #13 `external.send` (sensitive-by-default, recorded-only). For an
   * `auto_send` route with a wired `AutoApprover` and the kill switch off, it approves+executes through the
   * SAME #13 chokepoint and records an `auto_sent` audit receipt (the cap counter). Otherwise it leaves a
   * pending human approval — the safe default.
   */
  private async toReply(
    ticket: SupportTicket,
    memberId: string,
    draft: string,
    caps: SupportDeskCaps,
    forceApproval = false,
  ): Promise<{ ticket: SupportTicket; approvalRequestId: string; autoSent: boolean }> {
    const descriptor = buildSupportReply({
      summary: summarize(draft, 120),
      target: ticket.contact ?? undefined,
    });
    const req = await this.deps.gate.submit({
      workspaceId: ticket.workspaceId,
      requesterMemberId: memberId,
      actionType: descriptor.actionType,
      payload: { ...descriptor.payload, ticketId: ticket.id },
      amount: descriptor.amount,
      summary: `Reply to support ticket ${ticket.id}: ${summarize(draft, 80)}`,
    });

    const killed = this.deps.killSwitch ? await this.deps.killSwitch(ticket.workspaceId) : false;
    const canAutoSend = !forceApproval && caps.autoSend && !killed && this.deps.autoApprover;
    if (canAutoSend) {
      const { executed } = await this.deps.autoApprover!.approve({
        workspaceId: ticket.workspaceId,
        approvalRequestId: req.id,
        memberId,
        reason: `auto_send:${ticket.category ?? "other"}`,
      });
      if (executed) {
        // The auto-send audit marker — both the trail AND the per-day cap counter.
        await this.deps.receipts.create({
          workspaceId: ticket.workspaceId,
          ticketId: ticket.id,
          kind: "auto_sent",
          providerRef: req.id,
          detail: `auto_send:${ticket.category ?? "other"}`,
        });
        const updated = await this.patch(ticket, {
          status: "replied",
          replyApprovalRequestId: req.id,
          draftReply: draft,
        });
        return { ticket: updated, approvalRequestId: req.id, autoSent: true };
      }
    }

    // Pending human approval (the default, and the fallback when auto-send is not permitted/executed).
    const updated = await this.patch(ticket, {
      status: "awaiting_approval",
      replyApprovalRequestId: req.id,
      draftReply: draft,
    });
    return { ticket: updated, approvalRequestId: req.id, autoSent: false };
  }

  private async maybeRecordComplaint(ticket: SupportTicket): Promise<void> {
    if (!this.deps.complaints) return;
    const isComplaint =
      ticket.sentiment === "negative" || COMPLAINT_CATEGORIES.has(ticket.category ?? "");
    if (!isComplaint) return;
    const fp = fingerprintComplaint({
      category: ticket.category ?? "other",
      subject: ticket.subject,
      body: ticket.body,
    });
    await this.deps.complaints.record({
      workspaceId: ticket.workspaceId,
      ventureIdeaId: ticket.ventureIdeaId,
      signature: fp.signature,
      title: fp.title,
      category: ticket.category ?? "other",
      body: ticket.body,
    });
  }

  private async patch(
    ticket: SupportTicket,
    patch: Parameters<TicketStore["update"]>[2],
  ): Promise<SupportTicket> {
    const updated = await this.deps.tickets.update(ticket.workspaceId, ticket.id, patch);
    return updated ?? ticket;
  }

  // ---- ingest receipts ------------------------------------------------------------------------------

  /** Record an external delivery/resolution receipt (a signed provider webhook). Idempotent on its ref. */
  async ingestReceipt(
    input: CreateReceiptInput,
  ): Promise<{ receipt: SupportReceipt; deduped: boolean }> {
    return this.deps.receipts.create(input);
  }

  // ---- knowledge base -------------------------------------------------------------------------------

  async listKb(workspaceId: string, opts?: { category?: string }): Promise<KbEntry[]> {
    return this.deps.kb.list(workspaceId, opts);
  }

  /** Curate a KB entry by hand (AC2). Deduped on slug. */
  async upsertKb(
    input: NewKbEntry & { createdByMemberId?: string | null },
  ): Promise<{ entry: KbEntry; deduped: boolean }> {
    return this.deps.kb.upsert(input);
  }

  /** Distill a resolved ticket into a KB entry (AC4 — the desk learns). */
  async learnFromResolved(
    workspaceId: string,
    ticketId: string,
    resolution: string,
    memberId: string,
  ): Promise<{ entry: KbEntry; deduped: boolean }> {
    const ticket = await this.deps.tickets.get(workspaceId, ticketId);
    if (!ticket) throw new SupportNotFoundError("ticket not found");
    const newEntry = kbEntryFromResolvedTicket(
      {
        id: ticket.id,
        workspaceId: ticket.workspaceId,
        ventureIdeaId: ticket.ventureIdeaId,
        subject: ticket.subject,
        body: ticket.body,
        category: ticket.category ?? "other",
      },
      resolution,
    );
    return this.deps.kb.upsert({ ...newEntry, createdByMemberId: memberId });
  }

  /**
   * Mine recurring real prospect/customer questions into objection FAQ entries (#609). The output is a
   * published KB row with traceable ticket provenance; sends/publishing outside the KB remain untouched.
   */
  async refreshObjectionFaq(
    workspaceId: string,
    opts: { minCount?: number; createdByMemberId?: string | null } = {},
  ): Promise<ObjectionFaqRefresh> {
    const minCount = Math.max(2, Math.trunc(opts.minCount ?? 2));
    const tickets = await this.deps.tickets.list(workspaceId);
    const groups = new Map<string, { question: string; tickets: SupportTicket[] }>();
    for (const ticket of tickets) {
      const mined = mineObjectionQuestion(ticket);
      if (!mined) continue;
      const group = groups.get(mined.signature);
      if (group) {
        group.tickets.push(ticket);
      } else {
        groups.set(mined.signature, { question: mined.question, tickets: [ticket] });
      }
    }

    const drafts: ObjectionFaqDraft[] = [];
    for (const [signature, group] of groups.entries()) {
      if (group.tickets.length < minCount) continue;
      const question = group.question;
      const entry = {
        workspaceId,
        ventureIdeaId: group.tickets.find((t) => t.ventureIdeaId)?.ventureIdeaId ?? null,
        slug: kbSlug("FAQ " + question),
        title: "FAQ: " + question,
        body: buildObjectionFaqAnswer(question, group.tickets),
        category: "objection",
        source: "manual" as const,
        sourceTicketId: null,
        provenance: "objection_miner:" + signature + ":" + group.tickets.map((t) => t.id).join(","),
      };
      const { entry: saved, deduped } = await this.deps.kb.upsert({
        ...entry,
        createdByMemberId: opts.createdByMemberId ?? null,
      });
      drafts.push({
        signature,
        question,
        count: group.tickets.length,
        ticketIds: group.tickets.map((t) => t.id),
        kbEntryId: saved.id,
        slug: saved.slug,
        deduped,
      });
    }

    drafts.sort((a, b) => b.count - a.count || a.question.localeCompare(b.question));
    return { workspaceId, generatedAt: this.now(), minCount, drafts };
  }

  // ---- SLA + resolution metrics ---------------------------------------------------------------------

  /** First-response SLA breaches (read-only, for the founder brief). */
  async slaBreaches(workspaceId: string): Promise<SlaBreach[]> {
    const caps = this.deps.caps(workspaceId);
    const tickets = await this.deps.tickets.list(workspaceId);
    return computeSlaBreaches(
      tickets.map((t) => ({
        id: t.id,
        status: t.status,
        category: t.category ?? null,
        createdAt: t.createdAt,
      })),
      caps,
      this.now(),
    );
  }

  /** Resolution metrics — verified (external receipt) vs UNVERIFIED (status-only). */
  async resolutionMetrics(workspaceId: string): Promise<ResolutionMetrics> {
    const tickets = await this.deps.tickets.list(workspaceId);
    const receipts = await this.deps.receipts.listForResolution(workspaceId);
    return computeResolutionMetrics(
      tickets.map((t) => ({
        id: t.id,
        status: t.status,
        category: t.category ?? null,
        createdAt: t.createdAt,
      })),
      receipts,
    );
  }
}

const OBJECTION_KEYWORDS = [
  "soc2",
  "security",
  "privacy",
  "data",
  "price",
  "pricing",
  "cost",
  "budget",
  "integration",
  "integrations",
  "cancel",
  "refund",
  "contract",
] as const;

function mineObjectionQuestion(
  ticket: SupportTicket,
): { signature: string; question: string } | null {
  const text = ((ticket.subject ?? "") + " " + ticket.body).trim();
  if (!text.includes("?")) return null;
  const lower = text.toLowerCase();
  const keyword = OBJECTION_KEYWORDS.find((k) => lower.includes(k));
  if (!keyword) return null;
  const question = firstQuestion(ticket.subject, ticket.body);
  return { signature: keyword, question };
}

function firstQuestion(subject: string | null, body: string): string {
  const source = body.includes("?") ? body : (subject ?? "") + " " + body;
  const text = source.replace(/\s+/g, " ").trim();
  const idx = text.indexOf("?");
  const sentence = idx >= 0 ? text.slice(0, idx + 1) : text;
  return sentence.slice(0, 140) || "Common prospect objection";
}

function buildObjectionFaqAnswer(question: string, tickets: SupportTicket[]): string {
  const examples = tickets
    .slice(0, 3)
    .map((t) => "- " + summarize(t.body, 120))
    .join("\n");
  return [
    "Short answer: " + draftShortAnswer(question),
    "",
    "Why this comes up:",
    examples,
    "",
    "How to handle it:",
    "Acknowledge the concern directly, explain the current safeguard or path, and offer the next proof step before asking for commitment.",
  ].join("\n");
}

function draftShortAnswer(question: string): string {
  const lower = question.toLowerCase();
  if (
    lower.includes("soc2") ||
    lower.includes("security") ||
    lower.includes("privacy") ||
    lower.includes("data")
  ) {
    return "Security and customer-data handling are valid buying criteria; share the current controls, roadmap, and any available proof before the prospect commits.";
  }
  if (
    lower.includes("price") ||
    lower.includes("pricing") ||
    lower.includes("cost") ||
    lower.includes("budget")
  ) {
    return "Anchor the answer in the business outcome, the smallest starting package, and what proof the prospect needs before paying more.";
  }
  if (lower.includes("integration")) {
    return "Confirm the exact workflow they need, name the supported integration path, and offer a scoped setup step.";
  }
  return "Treat this as a real objection, answer with the clearest current proof, and name the next step that removes the risk.";
}
