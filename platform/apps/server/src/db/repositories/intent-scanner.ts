import { and, desc, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "../index.js";
import { intentLeads, intentMonitors } from "../schema/index.js";
import type {
  CreateIntentMonitorInput,
  IntentLeadRecord,
  IntentLeadStatus,
  IntentMonitorDefinition,
  IntentScannerStore,
} from "../../intent-scanner/types.js";

const MONITOR_COLUMNS = {
  id: intentMonitors.id,
  workspaceId: intentMonitors.workspaceId,
  source: intentMonitors.source,
  label: intentMonitors.label,
  enabled: intentMonitors.enabled,
  subreddits: intentMonitors.subreddits,
  keywords: intentMonitors.keywords,
  competitors: intentMonitors.competitors,
  questionPatterns: intentMonitors.questionPatterns,
  cadenceMinutes: intentMonitors.cadenceMinutes,
  minScore: intentMonitors.minScore,
  createdByMemberId: intentMonitors.createdByMemberId,
  lastScannedAt: intentMonitors.lastScannedAt,
  nextScanAt: intentMonitors.nextScanAt,
  createdAt: intentMonitors.createdAt,
  updatedAt: intentMonitors.updatedAt,
} as const;

const LEAD_COLUMNS = {
  id: intentLeads.id,
  workspaceId: intentLeads.workspaceId,
  monitorId: intentLeads.monitorId,
  source: intentLeads.source,
  externalRef: intentLeads.externalRef,
  url: intentLeads.url,
  authorLabel: intentLeads.authorLabel,
  community: intentLeads.community,
  title: intentLeads.title,
  bodyExcerpt: intentLeads.bodyExcerpt,
  matchedQuery: intentLeads.matchedQuery,
  intentCategory: intentLeads.intentCategory,
  intentScore: intentLeads.intentScore,
  evidence: intentLeads.evidence,
  matchedSignals: intentLeads.matchedSignals,
  draftReply: intentLeads.draftReply,
  status: intentLeads.status,
  approvalRequestId: intentLeads.approvalRequestId,
  detectedAt: intentLeads.detectedAt,
  firstSeenAt: intentLeads.firstSeenAt,
  updatedAt: intentLeads.updatedAt,
} as const;

export const MAX_INTENT_LEADS_LIMIT = 200;

export function clampIntentLeadsLimit(limit?: number, fallback = 50): number {
  if (!Number.isFinite(limit) || limit === undefined || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), MAX_INTENT_LEADS_LIMIT);
}

export const dbIntentScannerStore: IntentScannerStore = {
  async createMonitor(input: CreateIntentMonitorInput): Promise<IntentMonitorDefinition> {
    const now = new Date();
    const [row] = await db
      .insert(intentMonitors)
      .values({
        workspaceId: input.workspaceId,
        source: input.source,
        label: input.label ?? input.source + " buying-intent monitor",
        subreddits: input.subreddits ?? [],
        keywords: input.keywords ?? [],
        competitors: input.competitors ?? [],
        questionPatterns: input.questionPatterns ?? [],
        cadenceMinutes: input.cadenceMinutes ?? 15,
        minScore: input.minScore ?? 45,
        createdByMemberId: input.createdByMemberId ?? null,
        nextScanAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning(MONITOR_COLUMNS);
    return row as IntentMonitorDefinition;
  },

  async listMonitors(workspaceId: string): Promise<IntentMonitorDefinition[]> {
    const rows = await db
      .select(MONITOR_COLUMNS)
      .from(intentMonitors)
      .where(eq(intentMonitors.workspaceId, workspaceId))
      .orderBy(desc(intentMonitors.createdAt));
    return rows as IntentMonitorDefinition[];
  },

  async listDueMonitors(now: Date): Promise<IntentMonitorDefinition[]> {
    const rows = await db
      .select(MONITOR_COLUMNS)
      .from(intentMonitors)
      .where(
        and(
          eq(intentMonitors.enabled, true),
          or(isNull(intentMonitors.nextScanAt), lte(intentMonitors.nextScanAt, now)),
        ),
      )
      .orderBy(desc(intentMonitors.createdAt))
      .limit(500);
    return rows as IntentMonitorDefinition[];
  },

  async markMonitorScanned(monitorId: string, scannedAt: Date, nextScanAt: Date): Promise<void> {
    await db
      .update(intentMonitors)
      .set({ lastScannedAt: scannedAt, nextScanAt, updatedAt: scannedAt })
      .where(eq(intentMonitors.id, monitorId));
  },

  async upsertLead(input): Promise<{ lead: IntentLeadRecord; created: boolean }> {
    const [existing] = await db
      .select({ id: intentLeads.id })
      .from(intentLeads)
      .where(
        and(
          eq(intentLeads.workspaceId, input.workspaceId),
          eq(intentLeads.source, input.candidate.source),
          eq(intentLeads.externalRef, input.candidate.externalRef),
        ),
      )
      .limit(1);
    const now = new Date();
    const [row] = await db
      .insert(intentLeads)
      .values({
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
        detectedAt: input.detectedAt,
        firstSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [intentLeads.workspaceId, intentLeads.source, intentLeads.externalRef],
        set: {
          monitorId: input.monitorId,
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
          detectedAt: input.detectedAt,
          updatedAt: now,
        },
      })
      .returning(LEAD_COLUMNS);
    return { lead: row as IntentLeadRecord, created: !existing };
  },

  async listLeads(
    workspaceId: string,
    opts: { status?: IntentLeadStatus; limit?: number } = {},
  ): Promise<IntentLeadRecord[]> {
    const predicates = [eq(intentLeads.workspaceId, workspaceId)];
    if (opts.status) predicates.push(eq(intentLeads.status, opts.status));
    const rows = await db
      .select(LEAD_COLUMNS)
      .from(intentLeads)
      .where(and(...predicates))
      .orderBy(desc(intentLeads.intentScore), desc(intentLeads.updatedAt))
      .limit(clampIntentLeadsLimit(opts.limit));
    return rows as IntentLeadRecord[];
  },

  async getLead(workspaceId: string, leadId: string): Promise<IntentLeadRecord | undefined> {
    const [row] = await db
      .select(LEAD_COLUMNS)
      .from(intentLeads)
      .where(and(eq(intentLeads.workspaceId, workspaceId), eq(intentLeads.id, leadId)))
      .limit(1);
    return row as IntentLeadRecord | undefined;
  },

  async markLeadPendingApproval(input): Promise<IntentLeadRecord | undefined> {
    const [row] = await db
      .update(intentLeads)
      .set({
        status: "reply_pending_approval",
        approvalRequestId: input.approvalRequestId,
        updatedAt: new Date(),
      })
      .where(and(eq(intentLeads.workspaceId, input.workspaceId), eq(intentLeads.id, input.leadId)))
      .returning(LEAD_COLUMNS);
    return row as IntentLeadRecord | undefined;
  },

  async listWorkspacesWithEnabledMonitors(): Promise<string[]> {
    const rows = await db
      .select({ workspaceId: intentMonitors.workspaceId })
      .from(intentMonitors)
      .where(eq(intentMonitors.enabled, true));
    return Array.from(new Set(rows.map((row) => row.workspaceId)));
  },
};
