import { budgetExceeded } from "../scale/usage.js";
import type { AcquisitionBriefView } from "../acquisition/cac.js";

/**
 * Founder Briefings roll-up (#173, ADR-0173). **Pure**: given the read-structs gathered from every
 * subsystem (ships #172, blockers, the owner decision queue #13/#172/#146, spend #71, revenue #98,
 * per-venture P&L #107, scorecard movement #96, voice #114, the backlog #115) and a single clock
 * instant, compose the three things the company pushes to its owner — the **daily brief**, the
 * **weekly founder report**, and the unified **decision queue** — and render the brand-voice text.
 *
 * No IO and no clock of its own (the instant is passed in), so each view is one unit-tested function —
 * the #104 Founder Console pure-core pattern. The IO orchestrator (`service.ts`) gathers the inputs;
 * `default.ts` wires the real repos. Nothing here mutates: a briefing strictly READS the company.
 */

// ---- shared helpers ----------------------------------------------------------------------------

/** Time in queue, in seconds. Clamped to ≥ 0 (a future `createdAt` reads as age 0). */
export function ageSeconds(nowMs: number, createdAtMs: number): number {
  return Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
}

/** Count words in a rendered digest (whitespace-delimited, empties dropped). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Clamp a digest to a hard word budget: join the priority-ordered sentences, then take at most
 * `maxWords` words (a trailing `…` marks truncation but is not itself counted as a word). Guarantees
 * `wordCount(result.text) <= maxWords` for any input — the property the daily brief's "< 200 words"
 * acceptance rests on.
 */
export function clampWords(parts: string[], maxWords: number): { text: string; wordCount: number } {
  const joined = parts.filter((p) => p.trim().length > 0).join(" ");
  const words = joined.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return { text: joined, wordCount: words.length };
  return { text: words.slice(0, maxWords).join(" ") + "…", wordCount: maxWords };
}

/** Render an amount of cents as money (e.g. `$12.34`; non-USD currencies prefix the ISO code). */
export function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return currency.toLowerCase() === "usd" ? `$${amount}` : `${currency.toUpperCase()} ${amount}`;
}

// ---- decision queue (#13 approvals + #172 escalations + #146 constitution/pricing) -------------

/** The owner-decision source: an approval (#13), a guardrail escalation (#172), or a constitution
 * flag (#146, includes Article VIII pricing-ladder holds — the "pricing proposals" of the issue). */
export type DecisionKind = "approval" | "guardrail_escalation" | "constitution";

/** Coarse priority used to order the queue (critical first). Pure ordinal — see `IMPACT_RANK`. */
export type DecisionImpact = "critical" | "high" | "normal";

const IMPACT_RANK: Record<DecisionImpact, number> = { critical: 0, high: 1, normal: 2 };

/** Escalation-age thresholds (seconds). An item's level rises as it crosses each one. */
export interface EscalationThresholds {
  /** Age at/above which a decision is level-1 stale (gentle nudge). */
  level1Seconds: number;
  /** Age at/above which a decision is level-2 stale (firm nudge). */
  level2Seconds: number;
  /** Age at/above which a decision is level-3 stale (critical — the company is blocked on the owner). */
  level3Seconds: number;
}

/**
 * The escalation level of a decision given its age. Pure function of age (not of any stored state), so
 * each daily brief re-surfaces the queue with the *current* level — a stale decision is re-notified on
 * a rising schedule with no per-item watermark. 0 = fresh; 3 = critically stale.
 */
export function escalationLevel(age: number, t: EscalationThresholds): number {
  if (age >= t.level3Seconds) return 3;
  if (age >= t.level2Seconds) return 2;
  if (age >= t.level1Seconds) return 1;
  return 0;
}

/** One normalized owner-decision (the orchestrator maps every source onto this shape). */
export interface DecisionItem {
  kind: DecisionKind;
  id: string;
  title: string;
  impact: DecisionImpact;
  /** When the decision was raised (epoch ms) — the basis for its age + escalation. */
  createdAtMs: number;
  /** A one-tap link to act on it (approval URL / PR / violation), or null. */
  link: string | null;
}

/** A decision with its derived age + escalation level, ready to render. */
export interface DecisionQueueItem extends DecisionItem {
  ageSeconds: number;
  escalationLevel: number;
}

export interface DecisionQueueInput {
  workspaceId: string;
  nowMs: number;
  items: DecisionItem[];
  thresholds: EscalationThresholds;
}

export interface DecisionQueue {
  workspaceId: string;
  generatedAtMs: number;
  /** The single ordered queue: impact desc, then oldest-first (the bottleneck floats to the top). */
  items: DecisionQueueItem[];
  total: number;
  byImpact: { critical: number; high: number; normal: number };
  /** Items at escalation level ≥ 1 (aging past the first threshold). */
  stale: number;
  /** Items at escalation level 3 (critically stale — the owner is the blocker). */
  critical: number;
}

/**
 * Compose the one ordered decision queue from the normalized items. Ordered by **impact desc, then
 * oldest-first** so the longest-waiting high-impact decision is always at the top. Pure ⇒ the route,
 * the daily brief, and the weekly digest read the identical ordering.
 */
export function composeDecisionQueue(input: DecisionQueueInput): DecisionQueue {
  const items: DecisionQueueItem[] = input.items
    .map((d) => ({
      ...d,
      ageSeconds: ageSeconds(input.nowMs, d.createdAtMs),
      escalationLevel: escalationLevel(ageSeconds(input.nowMs, d.createdAtMs), input.thresholds),
    }))
    .sort((a, b) => {
      const r = IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact];
      return r !== 0 ? r : a.createdAtMs - b.createdAtMs;
    });

  return {
    workspaceId: input.workspaceId,
    generatedAtMs: input.nowMs,
    items,
    total: items.length,
    byImpact: {
      critical: items.filter((i) => i.impact === "critical").length,
      high: items.filter((i) => i.impact === "high").length,
      normal: items.filter((i) => i.impact === "normal").length,
    },
    stale: items.filter((i) => i.escalationLevel >= 1).length,
    critical: items.filter((i) => i.escalationLevel >= 3).length,
  };
}

// ---- daily brief -------------------------------------------------------------------------------

/** One shipped artifact (a #172 merged run, a venture FUND, …) reduced to a title + optional link. */
export interface ShippedItem {
  title: string;
  ref: string | null;
}

/** One blocked workstream (a #172 escalated run, …) with why it's stuck. */
export interface BlockedItem {
  title: string;
  reason: string;
  ref: string | null;
}

/** Current-window spend vs the resolved budget (#71 `tenant_usage` + the scale cap). */
export interface SpendSnapshot {
  window: string;
  estimatedCostCents: number;
  /** The resolved budget cap in cents (0 = no cap). */
  budgetCents: number;
  currency: string;
}

/** Open constitution violations (#146) the owner should review (pricing-ladder holds included). */
export interface ConstitutionSummary {
  open: number;
  topCodes: string[];
}

export interface DailyBriefInput {
  workspaceId: string;
  nowMs: number;
  /** The brand the company speaks as (brand voice). */
  brandName: string;
  /** What every agent shipped in the window. */
  shipped: ShippedItem[];
  /** What is blocked. */
  blocked: BlockedItem[];
  /** The owner decision queue (approvals waiting, with one-tap links). */
  decisionQueue: DecisionQueue;
  spend: SpendSnapshot;
  constitution: ConstitutionSummary;
  /**
   * Acquisition execution receipts (#189, AC5): real channel spend + CAC + failing channels for the
   * window. OPTIONAL — when undefined (the default, acquisition flag off) the brief renders exactly as
   * before, so existing composer tests and today's behavior are unchanged.
   */
  acquisition?: AcquisitionBriefView;
  /** Hard word budget for the rendered brief (default 200 at the caps layer). */
  maxWords: number;
}

export interface SpendView {
  estimatedCostCents: number;
  budgetCents: number;
  currency: string;
  overBudget: boolean;
  /** Spent / cap as a fraction; null when no positive cap is set. */
  utilization: number | null;
}

export interface DailyBrief {
  workspaceId: string;
  generatedAtMs: number;
  shipped: ShippedItem[];
  blocked: BlockedItem[];
  /** The owner decisions waiting, ordered (the queue items with links + ages). */
  decisionsWaiting: DecisionQueueItem[];
  spend: SpendView;
  constitution: ConstitutionSummary;
  /** The acquisition section (#189) when provided, else null. */
  acquisition: AcquisitionBriefView | null;
  /** The brand-voice brief, guaranteed `wordCount <= maxWords`. */
  text: string;
  wordCount: number;
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** UTC `YYYY-MM-DD` for the brief header. */
function isoDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Compose the daily brief: reshape the gathered structs and render the brand-voice text. The renderer
 * emits highest-signal sentences first (ships → blocks → decisions → spend → constitution) and is hard
 * word-budgeted (`clampWords`), so a maxed-out input still respects "< 200 words".
 */
export function composeDailyBrief(input: DailyBriefInput): DailyBrief {
  const overBudget = budgetExceeded(input.spend.estimatedCostCents, input.spend.budgetCents);
  const spend: SpendView = {
    estimatedCostCents: input.spend.estimatedCostCents,
    budgetCents: input.spend.budgetCents,
    currency: input.spend.currency,
    overBudget,
    utilization:
      input.spend.budgetCents > 0
        ? input.spend.estimatedCostCents / input.spend.budgetCents
        : null,
  };

  const decisionsWaiting = input.decisionQueue.items;
  const oldest = decisionsWaiting[0];

  // Priority-ordered sentences — `clampWords` keeps as many as fit the budget, header always first.
  const parts: string[] = [`${input.brandName} daily brief — ${isoDate(input.nowMs)}.`];

  if (input.shipped.length > 0) {
    const titles = input.shipped.slice(0, 3).map((s) => s.title).join(", ");
    parts.push(`Shipped ${pluralize(input.shipped.length, "item")}: ${titles}.`);
  } else {
    parts.push("Nothing shipped.");
  }

  if (input.blocked.length > 0) {
    parts.push(`Blocked ${pluralize(input.blocked.length, "item")}: ${input.blocked[0]!.reason}.`);
  }

  if (decisionsWaiting.length > 0) {
    const oldestAgeH = oldest ? Math.floor(oldest.ageSeconds / 3600) : 0;
    const crit = input.decisionQueue.critical;
    parts.push(
      `${pluralize(decisionsWaiting.length, "decision")} waiting on you` +
        ` (oldest ${oldestAgeH}h${crit > 0 ? `, ${crit} critical` : ""}).`,
    );
  } else {
    parts.push("No decisions waiting.");
  }

  const spent = formatMoney(spend.estimatedCostCents, spend.currency);
  if (spend.budgetCents > 0) {
    const pct = Math.round((spend.utilization ?? 0) * 100);
    parts.push(
      `Spend ${spent} / ${formatMoney(spend.budgetCents, spend.currency)} (${pct}%)` +
        `${overBudget ? " — over budget" : ""}.`,
    );
  } else {
    parts.push(`Spend ${spent}.`);
  }

  if (input.constitution.open > 0) {
    parts.push(
      `${pluralize(input.constitution.open, "constitution flag")} (${input.constitution.topCodes.join(", ")}).`,
    );
  }

  // #189 acquisition receipts (AC5): real channel spend + CAC + any failing channel. Rendered only when
  // the section is present (acquisition on) and there is something real to report. CAC is labeled
  // UNVERIFIED when the conversions backing it are not external receipts (premortem #200 §2).
  const acq = input.acquisition ?? null;
  if (acq && (acq.totalSpentCents > 0 || acq.totalConversions > 0 || acq.failingChannels.length > 0)) {
    const spent = formatMoney(acq.totalSpentCents, input.spend.currency);
    const cac =
      acq.blendedCacCents !== null
        ? `CAC ${formatMoney(acq.blendedCacCents, input.spend.currency)}${acq.verified ? "" : " (UNVERIFIED)"}`
        : "CAC n/a";
    parts.push(
      `Acquisition: ${spent} spent, ${pluralize(acq.totalConversions, "conversion")}, ${cac}.`,
    );
    if (acq.failingChannels.length > 0) {
      parts.push(`Channel failures: ${acq.failingChannels.join(", ")}.`);
    }
  }

  const { text, wordCount: wc } = clampWords(parts, input.maxWords);

  return {
    workspaceId: input.workspaceId,
    generatedAtMs: input.nowMs,
    shipped: input.shipped,
    blocked: input.blocked,
    decisionsWaiting,
    spend,
    constitution: input.constitution,
    acquisition: acq,
    text,
    wordCount: wc,
  };
}

// ---- weekly founder report ---------------------------------------------------------------------

/** The per-venture economics the orchestrator gathers (P&L + scorecard movement + the #107 decision). */
export interface VentureKpiSnapshot {
  ideaId: string;
  /** `active` (still looping) or `terminal`. */
  status: string;
  /** The latest #107 portfolio decision (DOUBLE_DOWN|MAINTAIN|PIVOT|SUNSET), or null when unreviewed. */
  decision: string | null;
  /** The latest adversarially-weighted score (#96), or null when no pass has run. */
  currentScore: number | null;
  /** The prior pass's score (#96), for movement, or null when there is no prior pass. */
  previousScore: number | null;
  /** Workspace revenue attributed at review time (#98/#107), or null when unreviewed (no per-venture split). */
  revenueCents: number | null;
  /** Infra cost at review time (#71), or null when unreviewed. */
  costCents: number | null;
}

/** One launched venture's P&L row in the weekly report. */
export interface VenturePnL {
  ideaId: string;
  status: string;
  /** The #107 kill/scale recommendation (DOUBLE_DOWN|MAINTAIN|PIVOT|SUNSET), or null. */
  decision: string | null;
  currentScore: number | null;
  previousScore: number | null;
  /** `currentScore − previousScore` when both are present, else null. */
  scoreDelta: number | null;
  revenueCents: number | null;
  costCents: number | null;
  /** `revenueCents − costCents` when both are present, else null. */
  netCents: number | null;
  /** `net / revenue × 100` when revenue is positive, else null. */
  marginPct: number | null;
  /** True when both revenue and cost are present (a real P&L row vs "—"). */
  hasPnl: boolean;
}

/** One top customer-voice signal (#114). */
export interface VoiceSignal {
  summary: string;
  sentiment: string;
  churnRisk: string;
}

/** One ranked next-week backlog item (#115). */
export interface BacklogEntry {
  title: string;
  score: number;
  position: number;
}

/**
 * The Finance Ledger close-pack section attached to the weekly report (#194, ADR-0194). Optional and
 * default-absent: when the finance layer is OFF (or unwired) `financeSection` is `undefined` and the
 * report renders byte-for-byte as before (the #114 composable-overlay discipline). When present it
 * carries the workspace-level monthly close + runway header, with `verifiedShareBps` so the owner sees
 * how much of the books rests on external receipts vs. UNVERIFIED estimates (the premortem #200).
 */
export interface FinanceBriefingSection {
  currency: string;
  periodKey: string;
  revenueCents: number;
  costCents: number;
  netCents: number;
  /** Basis points (0–10000) of the period's money magnitude that is externally verified. */
  verifiedShareBps: number;
  runwayHealth: "healthy" | "at_risk" | "breached";
  runwayDays: number | null;
  breachPeriodKey: string | null;
}

export interface WeeklyReportInput {
  workspaceId: string;
  nowMs: number;
  brandName: string;
  currency: string;
  /** Workspace-level revenue total (#98) — there is no per-venture split (see ADR-0107). */
  revenueTotalCents: number;
  ventures: VentureKpiSnapshot[];
  voiceSignals: VoiceSignal[];
  backlog: BacklogEntry[];
  /** Hard word budget for the rendered digest. */
  maxWords: number;
  /** Optional #194 finance close-pack section; absent ⇒ the report is unchanged. */
  financeSection?: FinanceBriefingSection;
}

export interface WeeklyReport {
  workspaceId: string;
  generatedAtMs: number;
  currency: string;
  revenueTotalCents: number;
  ventures: VenturePnL[];
  /** Kill/scale recommendation counts across reviewed ventures (#107). */
  recommendations: { doubleDown: number; maintain: number; pivot: number; sunset: number };
  voiceSignals: VoiceSignal[];
  backlog: BacklogEntry[];
  /** The #194 finance close-pack section, or `null` when the finance layer is off/unwired. */
  financeSection: FinanceBriefingSection | null;
  /** The brand-voice weekly digest, guaranteed `wordCount <= maxWords`. */
  text: string;
  wordCount: number;
}

/** Compose the weekly founder report: per-venture P&L + movement + recommendations + voice + backlog. */
export function composeWeeklyReport(input: WeeklyReportInput): WeeklyReport {
  const ventures: VenturePnL[] = input.ventures.map((v) => {
    const hasPnl = v.revenueCents !== null && v.costCents !== null;
    const netCents = hasPnl ? (v.revenueCents as number) - (v.costCents as number) : null;
    const marginPct =
      netCents !== null && v.revenueCents !== null && v.revenueCents > 0
        ? (netCents / v.revenueCents) * 100
        : null;
    const scoreDelta =
      v.currentScore !== null && v.previousScore !== null ? v.currentScore - v.previousScore : null;
    return {
      ideaId: v.ideaId,
      status: v.status,
      decision: v.decision,
      currentScore: v.currentScore,
      previousScore: v.previousScore,
      scoreDelta,
      revenueCents: v.revenueCents,
      costCents: v.costCents,
      netCents,
      marginPct,
      hasPnl,
    };
  });

  const recommendations = {
    doubleDown: ventures.filter((v) => v.decision === "DOUBLE_DOWN").length,
    maintain: ventures.filter((v) => v.decision === "MAINTAIN").length,
    pivot: ventures.filter((v) => v.decision === "PIVOT").length,
    sunset: ventures.filter((v) => v.decision === "SUNSET").length,
  };

  const parts: string[] = [
    `${input.brandName} weekly founder report — ${isoDate(input.nowMs)}.`,
    `Revenue ${formatMoney(input.revenueTotalCents, input.currency)} across ${pluralize(ventures.length, "venture")}.`,
  ];

  const profitable = ventures.filter((v) => v.netCents !== null && v.netCents > 0).length;
  const burning = ventures.filter((v) => v.netCents !== null && v.netCents < 0).length;
  if (ventures.some((v) => v.hasPnl)) {
    parts.push(`${profitable} profitable, ${burning} burning.`);
  }

  const fin = input.financeSection;
  if (fin) {
    const verifiedPct = (fin.verifiedShareBps / 100).toFixed(0);
    const runway =
      fin.runwayHealth === "breached"
        ? "runway breached"
        : fin.runwayDays !== null
          ? `~${fin.runwayDays}d runway${fin.runwayHealth === "at_risk" ? ` (at risk, breach ${fin.breachPeriodKey})` : ""}`
          : "no active burn";
    parts.push(
      `Books ${fin.periodKey}: net ${formatMoney(fin.netCents, fin.currency)} (${verifiedPct}% verified), ${runway}.`,
    );
  }

  if (recommendations.sunset > 0 || recommendations.pivot > 0 || recommendations.doubleDown > 0) {
    parts.push(
      `Recommendations: ${recommendations.doubleDown} double-down, ${recommendations.pivot} pivot, ${recommendations.sunset} sunset.`,
    );
  }

  if (input.voiceSignals.length > 0) {
    parts.push(`Top voice: ${input.voiceSignals[0]!.summary}.`);
  }

  if (input.backlog.length > 0) {
    const titles = input.backlog.slice(0, 3).map((b) => b.title).join(", ");
    parts.push(`Next week: ${titles}.`);
  }

  const { text, wordCount: wc } = clampWords(parts, input.maxWords);

  return {
    workspaceId: input.workspaceId,
    generatedAtMs: input.nowMs,
    currency: input.currency,
    revenueTotalCents: input.revenueTotalCents,
    ventures,
    recommendations,
    voiceSignals: input.voiceSignals,
    backlog: input.backlog,
    financeSection: input.financeSection ?? null,
    text,
    wordCount: wc,
  };
}
