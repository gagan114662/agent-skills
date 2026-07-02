import { INTENT_REPLY_ACTION } from "../approvals/policy.js";
import { draftIntentReply } from "./reply.js";
import { scoreIntentCandidate } from "./score.js";
import type {
  CreateIntentMonitorInput,
  IntentLeadRecord,
  IntentLeadStatus,
  IntentMonitorDefinition,
  IntentScanSummary,
  IntentScannerProvider,
  IntentScannerStore,
} from "./types.js";

const DEFAULT_MIN_SCORE = 45;
const DEFAULT_CADENCE_MINUTES = 15;
const MAX_SCAN_CANDIDATES = 100;

export class IntentScannerValidationError extends Error {}

export interface IntentApprovalGate {
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    lead: IntentLeadRecord;
  }): Promise<{ id: string }>;
}

export interface IntentScannerDeps {
  store: IntentScannerStore;
  provider: IntentScannerProvider;
  approvals: IntentApprovalGate;
  now?: () => Date;
}

export class IntentScannerService {
  constructor(private readonly deps: IntentScannerDeps) {}

  async createMonitor(input: CreateIntentMonitorInput): Promise<IntentMonitorDefinition> {
    if (!input.workspaceId) throw new IntentScannerValidationError("workspaceId is required");
    return this.deps.store.createMonitor({
      ...input,
      label: cleanLabel(input.label) || defaultLabel(input),
      keywords: cleanList(input.keywords),
      competitors: cleanList(input.competitors),
      questionPatterns: cleanList(input.questionPatterns),
      subreddits: cleanList(input.subreddits).map(stripSubredditPrefix),
      cadenceMinutes: clampInt(input.cadenceMinutes, 10, 60, DEFAULT_CADENCE_MINUTES),
      minScore: clampInt(input.minScore, 0, 100, DEFAULT_MIN_SCORE),
      createdByMemberId: input.createdByMemberId ?? null,
    });
  }

  listMonitors(workspaceId: string): Promise<IntentMonitorDefinition[]> {
    return this.deps.store.listMonitors(workspaceId);
  }

  listLeads(workspaceId: string, opts: { status?: IntentLeadStatus; limit?: number } = {}): Promise<IntentLeadRecord[]> {
    return this.deps.store.listLeads(workspaceId, opts);
  }

  async queueReply(workspaceId: string, leadId: string, requesterMemberId: string): Promise<IntentLeadRecord> {
    const lead = await this.deps.store.getLead(workspaceId, leadId);
    if (!lead) throw new IntentScannerValidationError("lead not found");
    if (lead.approvalRequestId) return lead;
    const approval = await this.deps.approvals.submit({ workspaceId, requesterMemberId, lead });
    const updated = await this.deps.store.markLeadPendingApproval({
      workspaceId,
      leadId,
      approvalRequestId: approval.id,
    });
    if (!updated) throw new IntentScannerValidationError("lead not found");
    return updated;
  }

  async tickWorkspace(workspaceId: string): Promise<IntentScanSummary> {
    const monitors = (await this.deps.store.listMonitors(workspaceId)).filter((monitor) => monitor.enabled);
    return this.scanMonitors(workspaceId, monitors);
  }

  async tickAll(): Promise<void> {
    const now = this.now();
    const due = await this.deps.store.listDueMonitors(now);
    const byWorkspace = new Map<string, IntentMonitorDefinition[]>();
    for (const monitor of due) {
      const existing = byWorkspace.get(monitor.workspaceId) ?? [];
      existing.push(monitor);
      byWorkspace.set(monitor.workspaceId, existing);
    }
    for (const [workspaceId, monitors] of byWorkspace) {
      await this.scanMonitors(workspaceId, monitors);
    }
  }

  private async scanMonitors(
    workspaceId: string,
    monitors: IntentMonitorDefinition[],
  ): Promise<IntentScanSummary> {
    const summary: IntentScanSummary = {
      workspaceId,
      monitorsScanned: 0,
      candidatesSeen: 0,
      leadsCreated: 0,
      leadsUpdated: 0,
      approvalsQueued: 0,
    };
    const now = this.now();

    for (const monitor of monitors) {
      summary.monitorsScanned += 1;
      const candidates = (await this.deps.provider.scan(monitor, {
        since: monitor.lastScannedAt,
        now,
      })).slice(0, MAX_SCAN_CANDIDATES);
      summary.candidatesSeen += candidates.length;

      for (const candidate of candidates) {
        const score = scoreIntentCandidate(monitor, candidate);
        if (score.category === "noise" || score.score < monitor.minScore || score.evidence.length === 0) {
          continue;
        }
        const result = await this.deps.store.upsertLead({
          workspaceId,
          monitorId: monitor.id,
          candidate,
          score,
          bodyExcerpt: excerpt([candidate.title, candidate.body ?? ""].join("\n\n")),
          draftReply: draftIntentReply({ candidate, score, productName: "ipop" }),
          detectedAt: candidate.occurredAt ?? now,
        });
        if (result.created) summary.leadsCreated += 1;
        else summary.leadsUpdated += 1;
        if (!result.lead.approvalRequestId && monitor.createdByMemberId) {
          const approval = await this.deps.approvals.submit({
            workspaceId,
            requesterMemberId: monitor.createdByMemberId,
            lead: result.lead,
          });
          await this.deps.store.markLeadPendingApproval({
            workspaceId,
            leadId: result.lead.id,
            approvalRequestId: approval.id,
          });
          summary.approvalsQueued += 1;
        }
      }

      const nextScanAt = new Date(now.getTime() + monitor.cadenceMinutes * 60_000);
      await this.deps.store.markMonitorScanned(monitor.id, now, nextScanAt);
    }

    return summary;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

export function intentApprovalPayload(lead: IntentLeadRecord): Record<string, unknown> {
  return {
    leadId: lead.id,
    source: lead.source,
    url: lead.url,
    community: lead.community,
    authorLabel: lead.authorLabel,
    intentCategory: lead.intentCategory,
    intentScore: lead.intentScore,
    evidence: lead.evidence,
    draftReply: lead.draftReply,
    target: lead.url,
    summary: approvalSummary(lead),
  };
}

export function approvalSummary(lead: IntentLeadRecord): string {
  return "Review reply to " + lead.source + " buying-intent lead: " + lead.title.slice(0, 120);
}

export { INTENT_REPLY_ACTION };

function defaultLabel(input: CreateIntentMonitorInput): string {
  const focus = [...cleanList(input.keywords), ...cleanList(input.competitors)][0];
  return focus ? input.source + " intent: " + focus : input.source + " buying-intent monitor";
}

function cleanList(value: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (value ?? [])
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.slice(0, 120)),
    ),
  ).slice(0, 50);
}

function cleanLabel(value: string | undefined): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function stripSubredditPrefix(value: string): string {
  return value.replace(/^r\//i, "").trim();
}

function excerpt(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const next = Math.trunc(value as number);
  if (next < min) return min;
  if (next > max) return max;
  return next;
}
