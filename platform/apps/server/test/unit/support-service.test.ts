import { describe, it, expect, beforeEach } from "vitest";
import {
  SupportDeskService,
  type SupportDeskServiceDeps,
  type KbStore,
  type ReceiptStore,
  type AutoApprover,
  type ComplaintRecorder,
} from "../../src/support/service.js";
import type { ReplyGate, SupportTicket, TicketStore } from "../../src/voice/service.js";
import type { KbEntry } from "../../src/support/kb.js";
import { SUPPORT_DESK_DEFAULTS, type SupportDeskCaps } from "../../src/support/caps.js";

// ---- fakes ------------------------------------------------------------------------------------------

function makeTicket(over: Partial<SupportTicket> = {}): SupportTicket {
  return {
    id: "tic-1",
    workspaceId: "ws-1",
    ventureIdeaId: null,
    channel: "widget",
    sourceRef: "src-1",
    contact: "user@example.com",
    subject: "How do I export?",
    body: "How do I export my data from the dashboard?",
    sentiment: "neutral",
    churnRisk: "low",
    category: "support",
    status: "triaged",
    draftReply: null,
    replyApprovalRequestId: null,
    triageSessionId: null,
    createdByMemberId: null,
    createdAt: new Date("2026-06-13T10:00:00Z"),
    updatedAt: new Date("2026-06-13T10:00:00Z"),
    ...over,
  };
}

class FakeTickets implements Pick<TicketStore, "get" | "list" | "update"> {
  constructor(private rows: Map<string, SupportTicket>) {}
  async get(wid: string, id: string) {
    const t = this.rows.get(id);
    return t && t.workspaceId === wid ? t : undefined;
  }
  async list(wid: string) {
    return [...this.rows.values()].filter((t) => t.workspaceId === wid);
  }
  async update(wid: string, id: string, patch: Record<string, unknown>) {
    const t = this.rows.get(id);
    if (!t || t.workspaceId !== wid) return undefined;
    const next = { ...t, ...patch, updatedAt: new Date() } as SupportTicket;
    this.rows.set(id, next);
    return next;
  }
}

class FakeKb implements KbStore {
  entries: KbEntry[] = [];
  async list() {
    return this.entries;
  }
  async get(_wid: string, id: string) {
    return this.entries.find((e) => e.id === id);
  }
  async upsert(input: Parameters<KbStore["upsert"]>[0]) {
    const entry: KbEntry = {
      id: `kb-${this.entries.length + 1}`,
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId,
      slug: input.slug,
      title: input.title,
      body: input.body,
      category: input.category,
      source: input.source,
      sourceTicketId: input.sourceTicketId,
      provenance: input.provenance,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.entries.push(entry);
    return { entry, deduped: false };
  }
}

class FakeReceipts implements ReceiptStore {
  rows: { workspaceId: string; ticketId: string | null; kind: string; providerRef: string }[] = [];
  async create(input: Parameters<ReceiptStore["create"]>[0]) {
    const receipt = {
      id: `r-${this.rows.length + 1}`,
      workspaceId: input.workspaceId,
      ticketId: input.ticketId,
      kind: input.kind,
      providerRef: input.providerRef,
      detail: input.detail ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      createdAt: new Date(),
    };
    this.rows.push({ workspaceId: input.workspaceId, ticketId: input.ticketId, kind: input.kind, providerRef: input.providerRef });
    return { receipt, deduped: false };
  }
  async listForResolution(wid: string) {
    return this.rows.filter((r) => r.workspaceId === wid).map((r) => ({ ticketId: r.ticketId, kind: r.kind }));
  }
  async countByKindSince(wid: string, kind: string) {
    return this.rows.filter((r) => r.workspaceId === wid && r.kind === kind).length;
  }
}

const gateCalls: { actionType: string; payload: Record<string, unknown> }[] = [];
const gate: ReplyGate = {
  async submit(input) {
    gateCalls.push({ actionType: input.actionType, payload: input.payload });
    return { id: `req-${gateCalls.length}` };
  },
};

const KB_EXPORT: KbEntry = {
  id: "kb-export",
  workspaceId: "ws-1",
  ventureIdeaId: null,
  slug: "export-data",
  title: "Export your data",
  body: "To export your data, open the dashboard, go to settings, and click Export.",
  category: "support",
  source: "manual",
  sourceTicketId: null,
  provenance: "manual",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const autoOnCaps: SupportDeskCaps = {
  ...SUPPORT_DESK_DEFAULTS,
  enabled: true,
  autoSend: true,
  autoSendCategories: ["support"],
  ownerWorkspaceOnly: true,
  autoSendMaxPerDay: 20,
};

function build(overrides: Partial<SupportDeskServiceDeps> = {}, tickets = new Map([["tic-1", makeTicket()]])) {
  const kb = new FakeKb();
  kb.entries = [KB_EXPORT];
  const receipts = new FakeReceipts();
  const deps: SupportDeskServiceDeps = {
    ingest: async () => ({ ticket: makeTicket(), deduped: false }),
    tickets: new FakeTickets(tickets),
    kb,
    receipts,
    gate,
    ownerWorkspace: async () => true,
    caps: () => autoOnCaps,
    now: () => new Date("2026-06-13T12:00:00Z"),
    ...overrides,
  };
  return { svc: new SupportDeskService(deps), kb, receipts, ticketsMap: tickets };
}

beforeEach(() => {
  gateCalls.length = 0;
});

describe("SupportDeskService — triage routing + bounded autonomy (#190)", () => {
  it("auto_send only EXECUTES when an AutoApprover is wired — and records the auto_sent audit receipt", async () => {
    const approved: string[] = [];
    const autoApprover: AutoApprover = {
      async approve(input) {
        approved.push(input.approvalRequestId);
        return { executed: true };
      },
    };
    const { svc, receipts, ticketsMap } = build({ autoApprover });
    const outcome = await svc.triageTicket("ws-1", "tic-1", "mem-1");

    expect(outcome.route).toBe("auto_send");
    expect(outcome.autoSent).toBe(true);
    expect(approved).toHaveLength(1);
    // The single send rode the #13 external.send path.
    expect(gateCalls[0]!.actionType).toBe("external.send");
    // The auto_sent audit/cap receipt was written.
    expect(receipts.rows.some((r) => r.kind === "auto_sent")).toBe(true);
    // The ticket is now replied.
    expect(ticketsMap.get("tic-1")!.status).toBe("replied");
    // The answer cited the KB entry as a receipt.
    expect(outcome.receipts).toContain("kb-export");
  });

  it("WITHOUT an AutoApprover, an auto_send route degrades to a pending human approval (the safe default)", async () => {
    const { svc, receipts, ticketsMap } = build(); // no autoApprover
    const outcome = await svc.triageTicket("ws-1", "tic-1", "mem-1");
    expect(outcome.route).toBe("auto_send"); // the gate still SAYS auto_send...
    expect(outcome.autoSent).toBe(false); // ...but nothing was sent
    expect(ticketsMap.get("tic-1")!.status).toBe("awaiting_approval");
    expect(receipts.rows.some((r) => r.kind === "auto_sent")).toBe(false);
  });

  it("the kill switch blocks an autonomous send even with an AutoApprover wired", async () => {
    const autoApprover: AutoApprover = { async approve() { return { executed: true }; } };
    const { svc, ticketsMap } = build({ autoApprover, killSwitch: async () => true });
    const outcome = await svc.triageTicket("ws-1", "tic-1", "mem-1");
    expect(outcome.autoSent).toBe(false);
    expect(ticketsMap.get("tic-1")!.status).toBe("awaiting_approval");
  });

  it("a refund intent routes to the MONEY queue as a gated billing.refund — never executed", async () => {
    const autoApprover: AutoApprover = { async approve() { return { executed: true }; } };
    const ticket = makeTicket({ body: "I want a refund immediately", category: "pricing" });
    const { svc, ticketsMap } = build({ autoApprover }, new Map([["tic-1", ticket]]));
    const outcome = await svc.triageTicket("ws-1", "tic-1", "mem-1");
    expect(outcome.route).toBe("money_queue");
    expect(outcome.autoSent).toBe(false);
    expect(gateCalls[0]!.actionType).toBe("billing.refund");
    expect(ticketsMap.get("tic-1")!.status).toBe("awaiting_approval");
  });

  it("a legal threat escalates with no #13 request, attaching the KB draft for a human", async () => {
    const ticket = makeTicket({ body: "my attorney will sue you over this", sentiment: "negative" });
    const { svc, ticketsMap } = build({}, new Map([["tic-1", ticket]]));
    const outcome = await svc.triageTicket("ws-1", "tic-1", "mem-1");
    expect(outcome.route).toBe("escalate");
    expect(outcome.escalationReasons).toContain("legal");
    expect(gateCalls).toHaveLength(0);
    expect(ticketsMap.get("tic-1")!.status).toBe("triaged");
  });

  it("a question the KB cannot answer escalates as 'unknown' — the desk never bluffs", async () => {
    const ticket = makeTicket({ body: "explain your quantum pricing tensor", subject: null });
    const { svc } = build({ autoApprover: { async approve() { return { executed: true }; } } }, new Map([["tic-1", ticket]]));
    const outcome = await svc.triageTicket("ws-1", "tic-1", "mem-1");
    expect(outcome.route).toBe("escalate");
    expect(outcome.escalationReasons).toContain("unknown");
  });

  it("re-triaging a ticket already awaiting approval is a no-op (never orphans the #13 request)", async () => {
    const ticket = makeTicket({ status: "awaiting_approval", replyApprovalRequestId: "req-existing" });
    const { svc } = build({}, new Map([["tic-1", ticket]]));
    const outcome = await svc.triageTicket("ws-1", "tic-1", "mem-1");
    expect(outcome.reason).toBe("noop:awaiting_approval");
    expect(gateCalls).toHaveLength(0);
  });

  it("records a recurring-complaint signal for a negative/complaint ticket (fingerprinted)", async () => {
    const recorded: { signature: string; category: string }[] = [];
    const complaints: ComplaintRecorder = {
      async record(input) {
        recorded.push({ signature: input.signature, category: input.category });
      },
    };
    const ticket = makeTicket({ body: "the export feature is broken and crashes", category: "bug", sentiment: "negative", churnRisk: "high" });
    const { svc } = build({ complaints }, new Map([["tic-1", ticket]]));
    await svc.triageTicket("ws-1", "tic-1", "mem-1");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.category).toBe("bug");
    expect(recorded[0]!.signature).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does NOT record a complaint for a calm, positive ticket", async () => {
    const recorded: unknown[] = [];
    const complaints: ComplaintRecorder = { async record() { recorded.push(1); } };
    const { svc } = build({ complaints });
    await svc.triageTicket("ws-1", "tic-1", "mem-1"); // neutral support question
    expect(recorded).toHaveLength(0);
  });

  it("the per-day cap blocks auto-send once reached (counts prior auto_sent receipts)", async () => {
    const autoApprover: AutoApprover = { async approve() { return { executed: true }; } };
    const { svc, receipts } = build({ autoApprover, caps: () => ({ ...autoOnCaps, autoSendMaxPerDay: 1 }) });
    // Seed one prior auto_sent receipt today.
    receipts.rows.push({ workspaceId: "ws-1", ticketId: "older", kind: "auto_sent", providerRef: "x" });
    const outcome = await svc.triageTicket("ws-1", "tic-1", "mem-1");
    expect(outcome.route).toBe("approval");
    expect(outcome.reason).toBe("approval:daily_cap_reached");
    expect(outcome.autoSent).toBe(false);
  });

  it("intakeWebhook with no owner member ingests but does not triage (no unattributed send)", async () => {
    const { svc } = build({ ownerMember: async () => null, ingest: async () => ({ ticket: makeTicket(), deduped: false }) });
    const outcome = await svc.intakeWebhook({ workspaceId: "ws-1", channel: "widget", sourceRef: "s", body: "hello" });
    expect(outcome.reason).toBe("no_owner_member");
    expect(gateCalls).toHaveLength(0);
  });

  it("learnFromResolved distills a resolved ticket into a KB entry", async () => {
    const { svc, kb } = build();
    const res = await svc.learnFromResolved("ws-1", "tic-1", "Open settings and click Export.", "mem-1");
    expect(res.entry.source).toBe("resolved_ticket");
    expect(res.entry.sourceTicketId).toBe("tic-1");
    expect(kb.entries.some((e) => e.source === "resolved_ticket")).toBe(true);
  });

  it("resolutionMetrics counts external receipts as verified, status-only as UNVERIFIED", async () => {
    const tickets = new Map([
      ["v", makeTicket({ id: "v", status: "closed" })],
      ["s", makeTicket({ id: "s", status: "replied" })],
    ]);
    const { svc, receipts } = build({}, tickets);
    receipts.rows.push({ workspaceId: "ws-1", ticketId: "v", kind: "resolved", providerRef: "p1" });
    const m = await svc.resolutionMetrics("ws-1");
    expect(m.resolvedVerified).toBe(1);
    expect(m.resolvedUnverified).toBe(1);
    expect(m.unverifiedLabeled).toBe(true);
  });

  it("slaBreaches flags an old unanswered ticket", async () => {
    const old = makeTicket({ id: "old", status: "open", createdAt: new Date("2026-06-13T00:00:00Z") }); // 12h old
    const { svc } = build({ caps: () => ({ ...autoOnCaps, firstResponseSlaMinutes: 60 }) }, new Map([["old", old]]));
    const breaches = await svc.slaBreaches("ws-1");
    expect(breaches.map((b) => b.ticketId)).toContain("old");
  });
});
