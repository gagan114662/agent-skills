import {
  composeDailyBrief,
  composeDecisionQueue,
  composeWeeklyReport,
  type BacklogEntry,
  type BlockedItem,
  type ConstitutionSummary,
  type IncidentSummary,
  type DailyBrief,
  type DecisionItem,
  type DecisionQueue,
  type ShippedItem,
  type VentureKpiSnapshot,
  type VoiceSignal,
  type WeeklyReport,
} from "./aggregate.js";
import { escalationThresholds, type BriefingsCaps } from "./caps.js";
import type { BriefingNotifier, DeliveryResult, DigestKind } from "./notifier.js";
import type { AcquisitionBriefView } from "../acquisition/cac.js";

/**
 * Founder Briefings IO orchestrator (#173, ADR-0173). Declares ONE read seam per data source, gathers
 * them concurrently for a workspace, and hands the structs to the pure composers in `aggregate.ts`. No
 * direct DB import — everything is a seam, so the service runs against fakes in unit tests and the real
 * repos in `default.ts`. **Read-only** over the business domain; the ONLY write is the briefing's own
 * delivery audit (`DeliveryStore`) — the idempotency watermark, exactly as #148 `PagerService` audits.
 */

/** What every agent shipped in the window (#172 merged runs, …). */
export interface ShipReader {
  shipped(workspaceId: string): Promise<ShippedItem[]>;
}

/** What is blocked (#172 escalated runs, …). */
export interface BlockReader {
  blocked(workspaceId: string): Promise<BlockedItem[]>;
}

/** The owner decision items: approvals (#13) + guardrail escalations (#172) + constitution/pricing (#146). */
export interface DecisionReader {
  items(workspaceId: string): Promise<DecisionItem[]>;
}

/** Current-window spend + the resolved budget cap (#71). */
export interface SpendReader {
  /** The window key (UTC `YYYY-MM`) usage is read for. */
  window(now: Date): string;
  usage(workspaceId: string, window: string): Promise<{ estimatedCostCents: number }>;
  budgetCents(workspaceId: string): number;
  currency(workspaceId: string): string;
}

/** Open constitution violations (#146). */
export interface ConstitutionReader {
  summary(workspaceId: string): Promise<ConstitutionSummary>;
}

/** Self-healing ops incidents (#193) — the overnight incident summary for the daily brief. */
export interface IncidentReader {
  summary(workspaceId: string): Promise<IncidentSummary>;
}

/** Per-venture KPI snapshot for the weekly P&L (#96/#98/#107/#71). */
export interface VentureKpiReader {
  ventures(workspaceId: string): Promise<VentureKpiSnapshot[]>;
}

/** Workspace-level revenue total (#98) — there is no per-venture split (see ADR-0107). */
export interface RevenueReader {
  total(workspaceId: string): Promise<{ totalCents: number; currency: string }>;
}

/** Top customer-voice signals (#114). */
export interface VoiceReader {
  signals(workspaceId: string, limit: number): Promise<VoiceSignal[]>;
}

/** Next week's ranked backlog (#115). */
export interface BacklogReader {
  upcoming(workspaceId: string, limit: number): Promise<BacklogEntry[]>;
}

/**
 * Acquisition execution receipts for the daily brief (#189, AC5). OPTIONAL on the deps — when absent (the
 * default) the brief omits the acquisition section entirely, unchanged from today. `section` returns null
 * when there is nothing to report (no spend / conversions / failures in the window).
 */
export interface AcquisitionReader {
  section(workspaceId: string): Promise<AcquisitionBriefView | null>;
}

/**
 * The delivery audit / idempotency watermark store. `wasDelivered` short-circuits a duplicate send in
 * the same period; `record` always persists the attempt (delivered or skipped). The unique
 * `(workspace_id, kind, period_key)` makes `record` idempotent under a concurrent tick.
 */
export interface DeliveryStore {
  wasDelivered(workspaceId: string, kind: DigestKind, periodKey: string): Promise<boolean>;
  record(input: {
    workspaceId: string;
    kind: DigestKind;
    periodKey: string;
    delivered: boolean;
    channels: DeliveryResult["channels"];
    wordCount: number;
  }): Promise<void>;
}

export interface FounderBriefingsDeps {
  caps(workspaceId: string): BriefingsCaps;
  /** The brand the company speaks as (brand voice). */
  brandName: string;
  ships: ShipReader;
  blocks: BlockReader;
  decisions: DecisionReader;
  spend: SpendReader;
  constitution: ConstitutionReader;
  /** Self-healing ops incidents (#193) — optional ⇒ a zeroed incident summary (loop off / unwired). */
  incidents?: IncidentReader;
  ventures: VentureKpiReader;
  revenue: RevenueReader;
  voice: VoiceReader;
  backlog: BacklogReader;
  notifier: BriefingNotifier;
  deliveries: DeliveryStore;
  /** Acquisition execution receipts (#189, AC5). Optional — absent → no acquisition section. */
  acquisition?: AcquisitionReader;
  /** Injectable clock (tests pin it). */
  now?: () => Date;
}

/** A delivery attempt's outcome (returned to the engine/tests). */
export interface DeliveryOutcome {
  workspaceId: string;
  kind: DigestKind;
  periodKey: string;
  status: "sent" | "skipped_disabled" | "skipped_already_sent";
  delivery?: DeliveryResult;
  wordCount?: number;
}

/** UTC `YYYY-MM-DD` — the daily-brief period key (one per calendar day). */
export function dailyPeriodKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** ISO-week `YYYY-Www` (Mon-based) — the weekly-report period key (one per ISO week). */
export function weeklyPeriodKey(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // ISO 8601: Thursday of the current week decides the year + week number.
  const day = d.getUTCDay() || 7; // Sun(0) → 7
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export class FounderBriefingsService {
  private readonly now: () => Date;
  constructor(private readonly deps: FounderBriefingsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The unified owner-decision queue (#13 + #172 + #146), ordered + escalation-leveled. */
  async decisionQueue(workspaceId: string): Promise<DecisionQueue> {
    const now = this.now();
    const caps = this.deps.caps(workspaceId);
    const items = await this.deps.decisions.items(workspaceId);
    return composeDecisionQueue({
      workspaceId,
      nowMs: now.getTime(),
      items,
      thresholds: escalationThresholds(caps),
    });
  }

  /** The daily brief view (read-only — used by the route + the delivery path). */
  async dailyBrief(workspaceId: string): Promise<DailyBrief> {
    const now = this.now();
    const caps = this.deps.caps(workspaceId);
    const window = this.deps.spend.window(now);
    const [shipped, blocked, decisionItems, usage, constitution, acquisition, incidents] =
      await Promise.all([
        this.deps.ships.shipped(workspaceId),
        this.deps.blocks.blocked(workspaceId),
        this.deps.decisions.items(workspaceId),
        this.deps.spend.usage(workspaceId, window),
        this.deps.constitution.summary(workspaceId),
        this.deps.acquisition ? this.deps.acquisition.section(workspaceId) : Promise.resolve(null),
        this.deps.incidents?.summary(workspaceId) ??
          Promise.resolve<IncidentSummary>({ open: 0, escalated: 0, resolved: 0, topVenture: null }),
      ]);
    const decisionQueue = composeDecisionQueue({
      workspaceId,
      nowMs: now.getTime(),
      items: decisionItems,
      thresholds: escalationThresholds(caps),
    });
    return composeDailyBrief({
      workspaceId,
      nowMs: now.getTime(),
      brandName: this.deps.brandName,
      shipped,
      blocked,
      decisionQueue,
      spend: {
        window,
        estimatedCostCents: usage.estimatedCostCents,
        budgetCents: this.deps.spend.budgetCents(workspaceId),
        currency: this.deps.spend.currency(workspaceId),
      },
      constitution,
      acquisition: acquisition ?? undefined,
      incidents,
      maxWords: caps.maxBriefWords,
    });
  }

  /** The weekly founder report view (read-only — used by the route + the delivery path). */
  async weeklyReport(workspaceId: string): Promise<WeeklyReport> {
    const now = this.now();
    const caps = this.deps.caps(workspaceId);
    const [ventures, revenue, voice, backlog] = await Promise.all([
      this.deps.ventures.ventures(workspaceId),
      this.deps.revenue.total(workspaceId),
      this.deps.voice.signals(workspaceId, caps.digestVoiceLimit),
      this.deps.backlog.upcoming(workspaceId, caps.backlogLimit),
    ]);
    return composeWeeklyReport({
      workspaceId,
      nowMs: now.getTime(),
      brandName: this.deps.brandName,
      currency: revenue.currency,
      revenueTotalCents: revenue.totalCents,
      ventures,
      voiceSignals: voice,
      backlog,
      maxWords: caps.maxReportWords,
    });
  }

  /** Deliver the daily brief for `workspaceId`, gated by caps + the idempotency watermark. */
  async deliverDaily(workspaceId: string, periodKey?: string): Promise<DeliveryOutcome> {
    const caps = this.deps.caps(workspaceId);
    const key = periodKey ?? dailyPeriodKey(this.now());
    if (!caps.enabled || !caps.daily) {
      return { workspaceId, kind: "daily", periodKey: key, status: "skipped_disabled" };
    }
    if (await this.deps.deliveries.wasDelivered(workspaceId, "daily", key)) {
      return { workspaceId, kind: "daily", periodKey: key, status: "skipped_already_sent" };
    }
    const brief = await this.dailyBrief(workspaceId);
    const delivery = await this.deps.notifier.deliver({
      workspaceId,
      kind: "daily",
      subject: `${this.deps.brandName} daily brief`,
      body: brief.text,
    });
    await this.deps.deliveries.record({
      workspaceId,
      kind: "daily",
      periodKey: key,
      delivered: delivery.anyDelivered,
      channels: delivery.channels,
      wordCount: brief.wordCount,
    });
    return { workspaceId, kind: "daily", periodKey: key, status: "sent", delivery, wordCount: brief.wordCount };
  }

  /** Deliver the weekly founder report for `workspaceId`, gated by caps + the idempotency watermark. */
  async deliverWeekly(workspaceId: string, periodKey?: string): Promise<DeliveryOutcome> {
    const caps = this.deps.caps(workspaceId);
    const key = periodKey ?? weeklyPeriodKey(this.now());
    if (!caps.enabled || !caps.weekly) {
      return { workspaceId, kind: "weekly", periodKey: key, status: "skipped_disabled" };
    }
    if (await this.deps.deliveries.wasDelivered(workspaceId, "weekly", key)) {
      return { workspaceId, kind: "weekly", periodKey: key, status: "skipped_already_sent" };
    }
    const report = await this.weeklyReport(workspaceId);
    const delivery = await this.deps.notifier.deliver({
      workspaceId,
      kind: "weekly",
      subject: `${this.deps.brandName} weekly founder report`,
      body: report.text,
    });
    await this.deps.deliveries.record({
      workspaceId,
      kind: "weekly",
      periodKey: key,
      delivered: delivery.anyDelivered,
      channels: delivery.channels,
      wordCount: report.wordCount,
    });
    return { workspaceId, kind: "weekly", periodKey: key, status: "sent", delivery, wordCount: report.wordCount };
  }
}
