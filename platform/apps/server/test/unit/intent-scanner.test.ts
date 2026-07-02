import { describe, expect, it } from "vitest";
import { IntentScannerService, type IntentApprovalGate } from "../../src/intent-scanner/service.js";
import { scoreIntentCandidate } from "../../src/intent-scanner/score.js";
import type {
  CreateIntentMonitorInput,
  IntentCandidate,
  IntentLeadRecord,
  IntentMonitorDefinition,
  IntentScannerProvider,
  IntentScannerStore,
  IntentScore,
} from "../../src/intent-scanner/types.js";

const now = new Date("2026-07-01T12:00:00.000Z");

function monitor(overrides: Partial<IntentMonitorDefinition> = {}): IntentMonitorDefinition {
  return {
    id: "mon-1",
    workspaceId: "workspace-1",
    source: "reddit",
    label: "reddit intent",
    enabled: true,
    subreddits: ["marketing"],
    keywords: ["marketing agency"],
    competitors: ["oldtool"],
    questionPatterns: ["recommend marketing"],
    cadenceMinutes: 15,
    minScore: 40,
    createdByMemberId: "member-1",
    lastScannedAt: null,
    nextScanAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function candidate(overrides: Partial<IntentCandidate> = {}): IntentCandidate {
  return {
    source: "reddit",
    externalRef: "thread-1",
    url: "https://reddit.com/r/marketing/comments/thread-1",
    authorLabel: "founder42",
    community: "r/marketing",
    title: "Looking for a marketing agency alternative",
    body: "We are switching from oldtool because reporting is too manual. Any recommendation for a marketing agency workflow?",
    matchedQuery: "marketing agency",
    occurredAt: now,
    ...overrides,
  };
}

class MemoryIntentStore implements IntentScannerStore {
  monitors = [monitor()];
  leads: IntentLeadRecord[] = [];

  async createMonitor(input: CreateIntentMonitorInput): Promise<IntentMonitorDefinition> {
    const next = monitor({ ...input, id: "mon-" + String(this.monitors.length + 1), createdAt: now, updatedAt: now });
    this.monitors.push(next);
    return next;
  }

  async listMonitors(workspaceId: string): Promise<IntentMonitorDefinition[]> {
    return this.monitors.filter((item) => item.workspaceId === workspaceId);
  }

  async listDueMonitors(scanNow: Date): Promise<IntentMonitorDefinition[]> {
    return this.monitors.filter((item) => item.enabled && (!item.nextScanAt || item.nextScanAt <= scanNow));
  }

  async markMonitorScanned(monitorId: string, scannedAt: Date, nextScanAt: Date): Promise<void> {
    this.monitors = this.monitors.map((item) =>
      item.id === monitorId ? { ...item, lastScannedAt: scannedAt, nextScanAt, updatedAt: scannedAt } : item,
    );
  }

  async upsertLead(input: {
    workspaceId: string;
    monitorId: string;
    candidate: IntentCandidate;
    score: IntentScore;
    bodyExcerpt: string;
    draftReply: string;
    detectedAt: Date;
  }): Promise<{ lead: IntentLeadRecord; created: boolean }> {
    const existing = this.leads.find(
      (lead) =>
        lead.workspaceId === input.workspaceId &&
        lead.source === input.candidate.source &&
        lead.externalRef === input.candidate.externalRef,
    );
    if (existing) {
      Object.assign(existing, {
        monitorId: input.monitorId,
        title: input.candidate.title,
        bodyExcerpt: input.bodyExcerpt,
        intentCategory: input.score.category,
        intentScore: input.score.score,
        evidence: input.score.evidence,
        matchedSignals: input.score.matchedSignals,
        draftReply: input.draftReply,
        updatedAt: now,
      });
      return { lead: existing, created: false };
    }
    const lead: IntentLeadRecord = {
      id: "lead-" + String(this.leads.length + 1),
      workspaceId: input.workspaceId,
      monitorId: input.monitorId,
      source: input.candidate.source,
      externalRef: input.candidate.externalRef,
      url: input.candidate.url,
      authorLabel: input.candidate.authorLabel ?? null,
      community: input.candidate.community ?? null,
      title: input.candidate.title,
      bodyExcerpt: input.bodyExcerpt,
      matchedQuery: input.candidate.matchedQuery ?? null,
      intentCategory: input.score.category,
      intentScore: input.score.score,
      evidence: input.score.evidence,
      matchedSignals: input.score.matchedSignals,
      draftReply: input.draftReply,
      status: "new",
      approvalRequestId: null,
      detectedAt: input.detectedAt,
      firstSeenAt: now,
      updatedAt: now,
    };
    this.leads.push(lead);
    return { lead, created: true };
  }

  async listLeads(): Promise<IntentLeadRecord[]> {
    return this.leads;
  }

  async getLead(workspaceId: string, leadId: string): Promise<IntentLeadRecord | undefined> {
    return this.leads.find((lead) => lead.workspaceId === workspaceId && lead.id === leadId);
  }

  async markLeadPendingApproval(input: {
    workspaceId: string;
    leadId: string;
    approvalRequestId: string;
  }): Promise<IntentLeadRecord | undefined> {
    const lead = await this.getLead(input.workspaceId, input.leadId);
    if (!lead) return undefined;
    lead.status = "reply_pending_approval";
    lead.approvalRequestId = input.approvalRequestId;
    lead.updatedAt = now;
    return lead;
  }

  async listWorkspacesWithEnabledMonitors(): Promise<string[]> {
    return ["workspace-1"];
  }
}

describe("intent scanner", () => {
  it("uses Unicode-aware keyword matching for non-English buying-intent text", () => {
    const scored = scoreIntentCandidate(
      monitor({ keywords: ["herramienta de marketing"], competitors: [], questionPatterns: [] }),
      candidate({
        title: "Que herramienta de marketing recomiendan?",
        body: "Busco una herramienta de marketing para lanzar contenido y anuncios sin contratar agencia.",
      }),
    );
    expect(scored.category).toBe("active_purchase_research");
    expect(scored.score).toBeGreaterThanOrEqual(40);
    expect(scored.evidence[0]?.quote).toMatch(/herramienta de marketing/i);
  });

  it("persists scored leads and parks the drafted reply behind approval once", async () => {
    const store = new MemoryIntentStore();
    const provider: IntentScannerProvider = { scan: async () => [candidate()] };
    const approvalIds: string[] = [];
    const approvals: IntentApprovalGate = {
      async submit() {
        const id = "approval-" + String(approvalIds.length + 1);
        approvalIds.push(id);
        return { id };
      },
    };
    const service = new IntentScannerService({ store, provider, approvals, now: () => now });

    const first = await service.tickWorkspace("workspace-1");
    expect(first).toMatchObject({
      monitorsScanned: 1,
      candidatesSeen: 1,
      leadsCreated: 1,
      approvalsQueued: 1,
    });
    expect(store.leads[0]?.status).toBe("reply_pending_approval");
    expect(store.leads[0]?.approvalRequestId).toBe("approval-1");
    expect(store.leads[0]?.draftReply).toMatch(/approval receipts/);

    const second = await service.tickWorkspace("workspace-1");
    expect(second).toMatchObject({ leadsUpdated: 1, approvalsQueued: 0 });
    expect(approvalIds).toEqual(["approval-1"]);
  });
});
