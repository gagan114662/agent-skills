import { describe, it, expect, beforeEach } from "vitest";
import {
  CustomerVoiceService,
  VoiceNotFoundError,
  VoiceStateError,
  type TicketStore,
  type InsightStore,
  type ReplyGate,
  type TriageAgent,
  type SupportTicket,
  type VoiceInsight,
  type CreateTicketInput,
  type CreateInsightInput,
} from "../../src/voice/service.js";
import { VOICE_DEFAULTS, type VoiceCaps } from "../../src/voice/caps.js";

let seq = 0;
const id = () => `id-${++seq}`;
const NOW = new Date("2026-06-11T00:00:00Z");

function makeTicketStore(): TicketStore & { rows: Map<string, SupportTicket> } {
  const rows = new Map<string, SupportTicket>();
  const keyOf = (ws: string, channel: string, ref: string) => `${ws}|${channel}|${ref}`;
  const byRef = new Map<string, string>();
  return {
    rows,
    async create(input: CreateTicketInput) {
      const k = keyOf(input.workspaceId, input.channel, input.sourceRef);
      const existingId = byRef.get(k);
      if (existingId) return { ticket: rows.get(existingId)!, deduped: true };
      const ticket: SupportTicket = {
        id: id(),
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        channel: input.channel,
        sourceRef: input.sourceRef,
        contact: input.contact,
        subject: input.subject,
        body: input.body,
        sentiment: input.sentiment,
        churnRisk: input.churnRisk,
        category: input.category,
        status: input.status,
        draftReply: null,
        replyApprovalRequestId: null,
        triageSessionId: null,
        createdByMemberId: input.createdByMemberId,
        createdAt: NOW,
        updatedAt: NOW,
      };
      rows.set(ticket.id, ticket);
      byRef.set(k, ticket.id);
      return { ticket, deduped: false };
    },
    async get(ws, tid) {
      const t = rows.get(tid);
      return t && t.workspaceId === ws ? t : undefined;
    },
    async list(ws, opts) {
      let all = [...rows.values()].filter((t) => t.workspaceId === ws);
      if (opts?.needsHuman) all = all.filter((t) => t.status !== "replied" && t.status !== "closed");
      return all;
    },
    async update(ws, tid, patch) {
      const t = rows.get(tid);
      if (!t || t.workspaceId !== ws) return undefined;
      Object.assign(t, patch, { updatedAt: NOW });
      return t;
    },
  };
}

function makeInsightStore(): InsightStore & { rows: VoiceInsight[] } {
  const rows: VoiceInsight[] = [];
  return {
    rows,
    async create(input: CreateInsightInput) {
      if (input.sourceRef !== null) {
        const dup = rows.find(
          (r) => r.workspaceId === input.workspaceId && r.sourceKind === input.sourceKind && r.sourceRef === input.sourceRef,
        );
        if (dup) return { insight: dup, deduped: true };
      }
      const insight: VoiceInsight = {
        id: id(),
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        ticketId: input.ticketId,
        kind: "user_voice",
        sourceKind: input.sourceKind,
        sentiment: input.sentiment,
        churnRisk: input.churnRisk,
        category: input.category,
        npsScore: input.npsScore,
        summary: input.summary,
        sourceRef: input.sourceRef,
        createdAt: NOW,
      };
      rows.push(insight);
      return { insight, deduped: false };
    },
    async list(ws, opts) {
      return rows.filter(
        (r) =>
          r.workspaceId === ws &&
          (opts?.ventureIdeaId === undefined || r.ventureIdeaId === opts.ventureIdeaId) &&
          (opts?.createdAfter === undefined || r.createdAt.getTime() >= opts.createdAfter.getTime()),
      );
    },
    async listForIdea(ws, ideaId) {
      return rows.filter((r) => r.workspaceId === ws && r.ventureIdeaId === ideaId);
    },
  };
}

function makeGate(): ReplyGate & { calls: { payload: Record<string, unknown>; status: string }[] } {
  const calls: { payload: Record<string, unknown>; status: string }[] = [];
  return {
    calls,
    async submit(input) {
      // The gate is the place sensitivity is enforced; the service must always submit external.send.
      calls.push({ payload: input.payload, status: "pending" });
      return { id: `req-${calls.length}` };
    },
  };
}

function build(opts: { caps?: Partial<VoiceCaps>; triage?: TriageAgent; killSwitch?: boolean } = {}) {
  const tickets = makeTicketStore();
  const insights = makeInsightStore();
  const gate = makeGate();
  const service = new CustomerVoiceService({
    tickets,
    insights,
    gate,
    triage: opts.triage,
    ventures: { exists: async (_ws, ideaId) => ideaId === "idea-1" },
    killSwitch: async () => opts.killSwitch ?? false,
    caps: () => ({ ...VOICE_DEFAULTS, ...opts.caps }),
    now: () => NOW,
  });
  return { service, tickets, insights, gate };
}

describe("CustomerVoiceService (#114) — IO orchestrator over fakes", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("ingestTicket: classifies → persists a ticket + a user_voice insight (the evidence row)", async () => {
    const { service, tickets, insights } = build();
    const r = await service.ingestTicket({
      workspaceId: "ws-1",
      channel: "email",
      sourceRef: "msg-1",
      contact: "user@e.com",
      subject: "broken",
      body: "the app keeps crashing with an error, totally broken",
      ventureIdeaId: "idea-1",
    });
    expect(r.deduped).toBe(false);
    expect(r.ticket.sentiment).toBe("negative");
    expect(r.ticket.category).toBe("bug");
    expect(r.insight.kind).toBe("user_voice");
    expect(r.insight.sourceKind).toBe("support_ticket");
    expect(r.insight.ticketId).toBe(r.ticket.id);
    expect(insights.rows).toHaveLength(1);
    expect(tickets.rows.size).toBe(1);
    // No triage agent wired → no draft, ticket needs a human.
    expect(r.ticket.draftReply).toBeNull();
  });

  it("ingestTicket is idempotent on (workspace, channel, sourceRef)", async () => {
    const { service, tickets } = build();
    const base = { workspaceId: "ws-1", channel: "email", sourceRef: "msg-x", body: "hi" };
    await service.ingestTicket(base);
    const again = await service.ingestTicket(base);
    expect(again.deduped).toBe(true);
    expect(tickets.rows.size).toBe(1);
  });

  it("ingestTicket with autoTriageDraft drafts a reply but NEVER sends it", async () => {
    const triage: TriageAgent = {
      draft: async () => ({ sessionId: "sess-1", draftReply: "Sorry about that — try X." }),
    };
    const { service, gate } = build({ caps: { enabled: true, autoTriageDraft: true }, triage });
    const r = await service.ingestTicket({ workspaceId: "ws-1", channel: "email", sourceRef: "m1", body: "broken" });
    expect(r.ticket.draftReply).toBe("Sorry about that — try X.");
    expect(r.ticket.triageSessionId).toBe("sess-1");
    // Drafting is NOT sending: nothing was submitted to the #13 gate.
    expect(gate.calls).toHaveLength(0);
  });

  it("autoTriageDraft is suppressed while the kill switch is engaged", async () => {
    const triage: TriageAgent = { draft: async () => ({ sessionId: "s", draftReply: "x" }) };
    const { service } = build({ caps: { enabled: true, autoTriageDraft: true }, triage, killSwitch: true });
    const r = await service.ingestTicket({ workspaceId: "ws-1", channel: "email", sourceRef: "m1", body: "broken" });
    expect(r.ticket.draftReply).toBeNull();
  });

  it("submitReply enqueues a sensitive-by-default external.send (pending) and moves the ticket to awaiting_approval — never sends", async () => {
    const { service, gate, tickets } = build();
    const t = await service.ingestTicket({ workspaceId: "ws-1", channel: "email", sourceRef: "m1", body: "help", contact: "u@e.com" });
    const res = await service.submitReply("ws-1", t.ticket.id, "member-1", "Here is how to fix it.");
    expect(res.approvalRequestId).toBe("req-1");
    expect(res.status).toBe("awaiting_approval");
    // The gate received an external.send (the sensitive-by-default action), status pending.
    expect(gate.calls).toHaveLength(1);
    expect(gate.calls[0].payload.kind).toBe("support.reply");
    expect(gate.calls[0].status).toBe("pending");
    const updated = tickets.rows.get(t.ticket.id)!;
    expect(updated.status).toBe("awaiting_approval");
    expect(updated.replyApprovalRequestId).toBe("req-1");
  });

  it("submitReply twice is blocked: a ticket awaiting_approval cannot orphan its pending request", async () => {
    const { service, gate, tickets } = build();
    const t = await service.ingestTicket({ workspaceId: "ws-1", channel: "email", sourceRef: "m1", body: "help", contact: "u@e.com" });
    const first = await service.submitReply("ws-1", t.ticket.id, "member-1", "first reply");
    // A second submit while awaiting_approval must throw — NOT create a second request.
    await expect(service.submitReply("ws-1", t.ticket.id, "member-1", "second reply")).rejects.toBeInstanceOf(VoiceStateError);
    expect(gate.calls).toHaveLength(1); // only the first reply reached the gate
    const ticket = tickets.rows.get(t.ticket.id)!;
    expect(ticket.replyApprovalRequestId).toBe(first.approvalRequestId); // unchanged — not orphaned
  });

  it("submitReply on a missing ticket → VoiceNotFoundError; on a closed ticket → VoiceStateError", async () => {
    const { service, tickets } = build();
    await expect(service.submitReply("ws-1", "nope", "m", "x")).rejects.toBeInstanceOf(VoiceNotFoundError);
    const t = await service.ingestTicket({ workspaceId: "ws-1", channel: "email", sourceRef: "m1", body: "hi" });
    await tickets.update("ws-1", t.ticket.id, { status: "closed" });
    await expect(service.submitReply("ws-1", t.ticket.id, "m", "x")).rejects.toBeInstanceOf(VoiceStateError);
  });

  it("IDOR: attaching a ticket/feedback to a venture idea not in the workspace → VoiceNotFoundError", async () => {
    const { service } = build();
    await expect(
      service.ingestTicket({ workspaceId: "ws-1", channel: "email", sourceRef: "m1", body: "hi", ventureIdeaId: "idea-other" }),
    ).rejects.toBeInstanceOf(VoiceNotFoundError);
  });

  it("ingestFeedback (nps/cancellation/abandon) persists insights without a ticket", async () => {
    const { service, insights, tickets } = build();
    await service.ingestFeedback({ workspaceId: "ws-1", sourceKind: "nps", sourceRef: "n1", npsScore: 2, text: "bad" });
    await service.ingestFeedback({ workspaceId: "ws-1", sourceKind: "cancellation", sourceRef: "c1", text: "leaving" });
    expect(insights.rows).toHaveLength(2);
    expect(tickets.rows.size).toBe(0);
    expect(insights.rows[0].sourceKind).toBe("nps");
  });

  it("metrics + digest roll up the insights; userVoiceEvidence reduces per-idea rows for the #96 overlay", async () => {
    const { service } = build();
    await service.ingestTicket({ workspaceId: "ws-1", channel: "email", sourceRef: "m1", body: "broken crash", ventureIdeaId: "idea-1" });
    await service.ingestFeedback({ workspaceId: "ws-1", sourceKind: "nps", sourceRef: "n1", npsScore: 10, text: "love", ventureIdeaId: "idea-1" });

    const m = await service.metrics("ws-1");
    expect(m.total).toBe(2);
    expect(m.nps.responses).toBe(1);

    const d = await service.digest("ws-1");
    expect(d.totalSignals).toBe(2);
    expect(typeof d.headline).toBe("string");

    const ev = await service.userVoiceEvidence("ws-1", "idea-1");
    expect(ev).toHaveLength(2);
    expect(ev[0]).toHaveProperty("sentiment");
  });

  it("needingHuman lists only tickets not yet replied/closed", async () => {
    const { service, tickets } = build();
    const a = await service.ingestTicket({ workspaceId: "ws-1", channel: "email", sourceRef: "a", body: "x" });
    const b = await service.ingestTicket({ workspaceId: "ws-1", channel: "email", sourceRef: "b", body: "y" });
    await tickets.update("ws-1", b.ticket.id, { status: "replied" });
    const open = await service.needingHuman("ws-1");
    expect(open.map((t) => t.id)).toEqual([a.ticket.id]);
  });
});
