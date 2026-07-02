export const INTENT_SOURCES = ["reddit", "x"] as const;
export type IntentSource = (typeof INTENT_SOURCES)[number];

export const INTENT_CATEGORIES = [
  "active_purchase_research",
  "pain_expression",
  "competitor_churn",
  "noise",
] as const;
export type IntentCategory = (typeof INTENT_CATEGORIES)[number];

export const INTENT_LEAD_STATUSES = [
  "new",
  "reply_pending_approval",
  "approved",
  "replied",
  "dismissed",
] as const;
export type IntentLeadStatus = (typeof INTENT_LEAD_STATUSES)[number];

export interface IntentEvidence {
  quote: string;
  reason: string;
}

export interface IntentMonitorDefinition {
  id: string;
  workspaceId: string;
  source: IntentSource;
  label: string;
  enabled: boolean;
  subreddits: string[];
  keywords: string[];
  competitors: string[];
  questionPatterns: string[];
  cadenceMinutes: number;
  minScore: number;
  createdByMemberId: string | null;
  lastScannedAt: Date | null;
  nextScanAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateIntentMonitorInput {
  workspaceId: string;
  source: IntentSource;
  label?: string;
  subreddits?: string[];
  keywords?: string[];
  competitors?: string[];
  questionPatterns?: string[];
  cadenceMinutes?: number;
  minScore?: number;
  createdByMemberId?: string | null;
}

export interface IntentCandidate {
  source: IntentSource;
  externalRef: string;
  url: string;
  authorLabel?: string | null;
  community?: string | null;
  title: string;
  body?: string | null;
  matchedQuery?: string | null;
  occurredAt?: Date | null;
}

export interface IntentScore {
  category: IntentCategory;
  score: number;
  evidence: IntentEvidence[];
  matchedSignals: string[];
}

export interface IntentLeadRecord {
  id: string;
  workspaceId: string;
  monitorId: string;
  source: IntentSource;
  externalRef: string;
  url: string;
  authorLabel: string | null;
  community: string | null;
  title: string;
  bodyExcerpt: string;
  matchedQuery: string | null;
  intentCategory: IntentCategory;
  intentScore: number;
  evidence: IntentEvidence[];
  matchedSignals: string[];
  draftReply: string;
  status: IntentLeadStatus;
  approvalRequestId: string | null;
  detectedAt: Date;
  firstSeenAt: Date;
  updatedAt: Date;
}

export interface IntentScanSummary {
  workspaceId: string;
  monitorsScanned: number;
  candidatesSeen: number;
  leadsCreated: number;
  leadsUpdated: number;
  approvalsQueued: number;
}

export interface IntentScannerProvider {
  scan(monitor: IntentMonitorDefinition, opts: { since: Date | null; now: Date }): Promise<IntentCandidate[]>;
}

export interface IntentScannerStore {
  createMonitor(input: CreateIntentMonitorInput): Promise<IntentMonitorDefinition>;
  listMonitors(workspaceId: string): Promise<IntentMonitorDefinition[]>;
  listDueMonitors(now: Date): Promise<IntentMonitorDefinition[]>;
  markMonitorScanned(monitorId: string, scannedAt: Date, nextScanAt: Date): Promise<void>;
  upsertLead(input: {
    workspaceId: string;
    monitorId: string;
    candidate: IntentCandidate;
    score: IntentScore;
    bodyExcerpt: string;
    draftReply: string;
    detectedAt: Date;
  }): Promise<{ lead: IntentLeadRecord; created: boolean }>;
  listLeads(workspaceId: string, opts?: { status?: IntentLeadStatus; limit?: number }): Promise<IntentLeadRecord[]>;
  getLead(workspaceId: string, leadId: string): Promise<IntentLeadRecord | undefined>;
  markLeadPendingApproval(input: {
    workspaceId: string;
    leadId: string;
    approvalRequestId: string;
  }): Promise<IntentLeadRecord | undefined>;
  listWorkspacesWithEnabledMonitors(): Promise<string[]>;
}

export function isIntentSource(value: unknown): value is IntentSource {
  return typeof value === "string" && (INTENT_SOURCES as readonly string[]).includes(value);
}

export function isIntentLeadStatus(value: unknown): value is IntentLeadStatus {
  return typeof value === "string" && (INTENT_LEAD_STATUSES as readonly string[]).includes(value);
}
