import {
  DISCOVERY_DEF_KINDS,
  DISCOVERY_SIGNAL_KINDS,
  GTM_STAGES,
} from "../db/schema/discovery.js";

/**
 * Customer Discovery Engine — pure scoring core (#222, ADR-0222). NO IO, NO clock, NO config: every
 * function is deterministic in its inputs (timestamps are passed as ms-epoch numbers), so it runs against
 * fakes in unit tests and the real repos in `default.ts`. This is where the "who do I reach out to now"
 * decision actually lives:
 *   - {@link evaluateDef}     — does a prospect's REAL signals satisfy one owner-defined definition?
 *   - {@link detectQualifications} — which (prospect, def) pairs newly qualify → PQL emissions.
 *   - {@link rankProspects}   — the daily ranked discovery queue, scored by conversion likelihood.
 *   - {@link pipelineMetrics} — the 5-stage GTM pipeline counts + stage-to-stage conversion rates.
 *
 * Guardrail (premortem #200 §2): a likelihood score is a PREDICTION — it is ALWAYS labeled UNVERIFIED.
 * Only a signal carrying a non-empty `externalRef` (a real outside receipt) is treated as verified.
 */

export type DiscoveryDefKind = (typeof DISCOVERY_DEF_KINDS)[number];
export type DiscoverySignalKind = (typeof DISCOVERY_SIGNAL_KINDS)[number];
export type GtmStage = (typeof GTM_STAGES)[number];

export function isDiscoveryDefKind(v: unknown): v is DiscoveryDefKind {
  return typeof v === "string" && (DISCOVERY_DEF_KINDS as readonly string[]).includes(v);
}
export function isDiscoverySignalKind(v: unknown): v is DiscoverySignalKind {
  return typeof v === "string" && (DISCOVERY_SIGNAL_KINDS as readonly string[]).includes(v);
}
export function isGtmStage(v: unknown): v is GtmStage {
  return typeof v === "string" && (GTM_STAGES as readonly string[]).includes(v);
}

/** The label a likelihood score always carries until an external receipt confirms it (premortem #200 §2). */
export const UNVERIFIED_LABEL = "UNVERIFIED" as const;

/** One real product/channel receipt, reduced to what the scorer reads (timestamps as ms-epoch). */
export interface DiscoverySignalInput {
  prospectKey: string;
  kind: DiscoverySignalKind;
  value: number;
  role: string | null;
  /** A real external reference (e.g. Stripe event id); non-empty ⇒ externally attributed. */
  externalRef: string | null;
  occurredAtMs: number;
}

/** One owner-defined qualifying signal, reduced to what the scorer reads. */
export interface SignalDefInput {
  id: string;
  kind: DiscoveryDefKind;
  threshold: number;
  windowDays: number;
  role: string | null;
  /** 0–100 contribution to the likelihood score. */
  weight: number;
  enabled: boolean;
}

/** One definition a prospect satisfied + the signal kinds that fired it. */
export interface DefMatch {
  defId: string;
  defKind: DiscoveryDefKind;
  weight: number;
  contributingSignalKinds: DiscoverySignalKind[];
  /** True when at least one contributing signal carried a real `externalRef` (externally grounded). */
  externallyGrounded: boolean;
}

/**
 * One row of the ranked discovery queue — the **stable contract** the decision-maker resolver (#223) and
 * the outreach engine (#225) consume. `score` is a 0–100 conversion likelihood that is ALWAYS a prediction:
 * `scoreVerified` is `false` and `likelihoodLabel` is `"UNVERIFIED"` until an external receipt confirms a
 * conversion. Each row carries the qualifying definition(s) + the signal kind(s) that earned the rank.
 */
export interface DiscoveryProspect {
  prospectKey: string;
  score: number;
  scoreVerified: false;
  likelihoodLabel: typeof UNVERIFIED_LABEL;
  role: string | null;
  signalCount: number;
  lastSignalAtMs: number;
  qualifyingDefs: DefMatch[];
  qualifyingSignalKinds: DiscoverySignalKind[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function windowStartMs(nowMs: number, windowDays: number): number {
  return nowMs - Math.max(1, windowDays) * DAY_MS;
}

function normalizeRole(role: string | null | undefined): string {
  return (role ?? "").trim().toLowerCase();
}

/** Sum a signal kind's `value` over a prospect's in-window signals. */
function sumValue(
  signals: readonly DiscoverySignalInput[],
  kind: DiscoverySignalKind,
  fromMs: number,
): number {
  let total = 0;
  for (const s of signals) {
    if (s.kind === kind && s.occurredAtMs >= fromMs && s.value > 0) total += s.value;
  }
  return total;
}

/**
 * Evaluate ONE owner-defined definition against ONE prospect's signals (already this prospect's only).
 * Returns a {@link DefMatch} when the prospect qualifies, else `null`. Pure + deterministic.
 *
 * - `power_user_threshold`: in-window `usage_event` value sum ≥ `threshold`.
 * - `usage_trend`: usage is trending UP — the recent half-window's usage sum strictly exceeds the older
 *   half's, and the in-window total is ≥ `threshold` (so a single blip never qualifies).
 * - `pricing_page_visit`: ≥ `threshold` (default 1) in-window `pricing_page_visit` signals — buying intent.
 * - `role_match`: an in-window `role_identified` signal (or any signal) whose role matches `def.role`.
 */
export function evaluateDef(
  def: SignalDefInput,
  signals: readonly DiscoverySignalInput[],
  nowMs: number,
): DefMatch | null {
  if (!def.enabled) return null;
  const fromMs = windowStartMs(nowMs, def.windowDays);
  const inWindow = signals.filter((s) => s.occurredAtMs >= fromMs);
  if (inWindow.length === 0) return null;

  const contributing: DiscoverySignalKind[] = [];
  let qualified = false;

  switch (def.kind) {
    case "power_user_threshold": {
      const usage = sumValue(signals, "usage_event", fromMs);
      if (usage >= Math.max(1, def.threshold)) {
        qualified = true;
        contributing.push("usage_event");
      }
      break;
    }
    case "usage_trend": {
      const midMs = fromMs + (nowMs - fromMs) / 2;
      const recent = sumValue(signals, "usage_event", midMs);
      const older = sumValue(signals, "usage_event", fromMs) - recent;
      const total = recent + older;
      if (recent > older && total >= Math.max(1, def.threshold)) {
        qualified = true;
        contributing.push("usage_event");
      }
      break;
    }
    case "pricing_page_visit": {
      const visits = inWindow.filter((s) => s.kind === "pricing_page_visit").length;
      if (visits >= Math.max(1, def.threshold)) {
        qualified = true;
        contributing.push("pricing_page_visit");
      }
      break;
    }
    case "role_match": {
      const target = normalizeRole(def.role);
      if (target.length > 0) {
        const match = inWindow.find((s) => normalizeRole(s.role) === target);
        if (match) {
          qualified = true;
          contributing.push(match.kind);
        }
      }
      break;
    }
  }

  if (!qualified) return null;
  const externallyGrounded = inWindow.some(
    (s) => contributing.includes(s.kind) && (s.externalRef ?? "").trim().length > 0,
  );
  return {
    defId: def.id,
    defKind: def.kind,
    weight: clamp(def.weight, 0, 100),
    contributingSignalKinds: [...new Set(contributing)],
    externallyGrounded,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** Group a flat signal list by prospect key (stable insertion order). */
function groupByProspect(
  signals: readonly DiscoverySignalInput[],
): Map<string, DiscoverySignalInput[]> {
  const byKey = new Map<string, DiscoverySignalInput[]>();
  for (const s of signals) {
    const list = byKey.get(s.prospectKey);
    if (list) list.push(s);
    else byKey.set(s.prospectKey, [s]);
  }
  return byKey;
}

/**
 * The 0–100 conversion LIKELIHOOD for a prospect, from its matched definitions. Deterministic. The score
 * is a prediction (always UNVERIFIED): it blends the matched definitions' weights (saturating, so one
 * strong def already scores high and more defs add with diminishing returns), a recency boost (a prospect
 * active today outranks a stale one), and a small multi-signal-diversity bonus. Never exceeds 100.
 */
export function scoreProspect(
  matches: readonly DefMatch[],
  lastSignalAtMs: number,
  nowMs: number,
): number {
  if (matches.length === 0) return 0;
  // Saturating sum of weights: each successive def contributes with diminishing returns so the score
  // approaches but never reaches 100 from definitions alone.
  const sorted = [...matches].sort((a, b) => b.weight - a.weight);
  let remaining = 100;
  let base = 0;
  for (const m of sorted) {
    const contribution = (m.weight / 100) * remaining;
    base += contribution;
    remaining -= contribution;
  }
  // Recency: full boost within a day, decaying to 0 over ~30 days.
  const ageDays = Math.max(0, (nowMs - lastSignalAtMs) / DAY_MS);
  const recency = clamp(1 - ageDays / 30, 0, 1) * 12;
  // Diversity: a prospect qualified by multiple distinct signal kinds is a stronger lead.
  const kinds = new Set(matches.flatMap((m) => m.contributingSignalKinds));
  const diversity = clamp((kinds.size - 1) * 4, 0, 12);
  return Math.round(clamp(base + recency + diversity, 0, 100));
}

/** Options shared by the queue + qualification passes. */
export interface DiscoveryRankOptions {
  nowMs: number;
  /** Max rows to return (the daily top-N queue cap). */
  limit?: number;
}

/**
 * THE DAILY RANKED DISCOVERY QUEUE (AC1/AC3). Groups signals by prospect, evaluates every enabled
 * definition, keeps prospects that match ≥1 definition, scores each by conversion likelihood, and returns
 * them descending by score (ties broken by most-recent activity), capped to `limit`. Every row's `score`
 * is UNVERIFIED (a prediction). Pure + deterministic.
 */
export function rankProspects(
  signals: readonly DiscoverySignalInput[],
  defs: readonly SignalDefInput[],
  opts: DiscoveryRankOptions,
): DiscoveryProspect[] {
  const enabledDefs = defs.filter((d) => d.enabled);
  const byProspect = groupByProspect(signals);
  const out: DiscoveryProspect[] = [];

  for (const [prospectKey, list] of byProspect) {
    const matches: DefMatch[] = [];
    for (const def of enabledDefs) {
      const m = evaluateDef(def, list, opts.nowMs);
      if (m) matches.push(m);
    }
    if (matches.length === 0) continue;

    const lastSignalAtMs = list.reduce((max, s) => Math.max(max, s.occurredAtMs), 0);
    const score = scoreProspect(matches, lastSignalAtMs, opts.nowMs);
    const qualifyingSignalKinds = [
      ...new Set(matches.flatMap((m) => m.contributingSignalKinds)),
    ];
    // The most-recently identified role for this prospect (latest first), if any.
    const role =
      [...list]
        .sort((a, b) => b.occurredAtMs - a.occurredAtMs)
        .find((s) => normalizeRole(s.role).length > 0)?.role ?? null;

    out.push({
      prospectKey,
      score,
      scoreVerified: false,
      likelihoodLabel: UNVERIFIED_LABEL,
      role,
      signalCount: list.length,
      lastSignalAtMs,
      qualifyingDefs: matches,
      qualifyingSignalKinds,
    });
  }

  out.sort((a, b) => b.score - a.score || b.lastSignalAtMs - a.lastSignalAtMs);
  const limit = opts.limit ?? out.length;
  return out.slice(0, Math.max(0, limit));
}

/** A newly-qualified (prospect, definition) pair the service persists as a PQL event. */
export interface QualificationEmission {
  prospectKey: string;
  defId: string;
  defKind: DiscoveryDefKind;
  score: number;
  /** True only when the qualification was externally grounded (a real receipt drove it). */
  verified: boolean;
  qualifyingSignalKinds: DiscoverySignalKind[];
}

/**
 * Detect every (prospect, def) qualification across the signal set, EXCLUDING pairs already emitted
 * (`alreadyEmitted` holds `${prospectKey} ${defId}` keys). The service feeds the result to the PQL
 * store + the growth funnel. Pure + deterministic. `score` reuses {@link scoreProspect} so a PQL carries
 * the same likelihood the queue shows; `verified` is the def's external-grounding (not the prediction).
 */
export function detectQualifications(
  signals: readonly DiscoverySignalInput[],
  defs: readonly SignalDefInput[],
  opts: DiscoveryRankOptions,
  alreadyEmitted: ReadonlySet<string> = new Set(),
): QualificationEmission[] {
  const enabledDefs = defs.filter((d) => d.enabled);
  const byProspect = groupByProspect(signals);
  const out: QualificationEmission[] = [];

  for (const [prospectKey, list] of byProspect) {
    const matches: DefMatch[] = [];
    for (const def of enabledDefs) {
      const m = evaluateDef(def, list, opts.nowMs);
      if (m) matches.push(m);
    }
    if (matches.length === 0) continue;
    const lastSignalAtMs = list.reduce((max, s) => Math.max(max, s.occurredAtMs), 0);
    const score = scoreProspect(matches, lastSignalAtMs, opts.nowMs);
    for (const m of matches) {
      if (alreadyEmitted.has(emittedKey(prospectKey, m.defId))) continue;
      out.push({
        prospectKey,
        defId: m.defId,
        defKind: m.defKind,
        score,
        verified: m.externallyGrounded,
        qualifyingSignalKinds: m.contributingSignalKinds,
      });
    }
  }
  return out;
}

/**
 * The dedupe key for an emitted PQL. Single source of truth — the repo's idempotency set and this detector
 * MUST agree, so always build it through this function (never hand-concatenate). A space separator is safe
 * because the second part is always a uuid `defId` (or empty), which contains no space.
 */
export function emittedKey(prospectKey: string, defId: string): string {
  return `${prospectKey} ${defId}`;
}

/** One stage's roll-up in the GTM pipeline metrics. */
export interface PipelineStageMetric {
  stage: GtmStage;
  /** Distinct prospects that entered this stage. */
  prospects: number;
  /** Of those, the count whose entry was externally grounded (a real receipt). */
  verifiedProspects: number;
}

/** A stage-to-stage conversion rate along the canonical 5-stage order. */
export interface StageConversion {
  from: GtmStage;
  to: GtmStage;
  /** `to` prospects / `from` prospects, clamped to [0,1]; 0 when `from` is empty. */
  rate: number;
}

/** The 5-stage GTM pipeline metrics fed into the founder-console growth panel (#104). */
export interface GtmPipelineMetrics {
  stages: PipelineStageMetric[];
  stageConversions: StageConversion[];
  /** Distinct prospects across all stages. */
  totalProspects: number;
}

/** One pipeline-entry row reduced to what the metrics read. */
export interface PipelineEntryInput {
  prospectKey: string;
  stage: GtmStage;
  verified: boolean;
}

/**
 * Roll pipeline entries into per-stage distinct-prospect counts + stage-to-stage conversion rates along
 * the canonical outreach → discovery → conversion → onboarding → post_sales order. Pure + deterministic.
 * Always returns all five stages (0 when empty — honest, never fabricated).
 */
export function pipelineMetrics(entries: readonly PipelineEntryInput[]): GtmPipelineMetrics {
  const perStage = new Map<GtmStage, { all: Set<string>; verified: Set<string> }>();
  for (const stage of GTM_STAGES) {
    perStage.set(stage, { all: new Set(), verified: new Set() });
  }
  const allProspects = new Set<string>();
  for (const e of entries) {
    if (!isGtmStage(e.stage)) continue;
    const bucket = perStage.get(e.stage)!;
    bucket.all.add(e.prospectKey);
    if (e.verified) bucket.verified.add(e.prospectKey);
    allProspects.add(e.prospectKey);
  }

  const stages: PipelineStageMetric[] = GTM_STAGES.map((stage) => {
    const bucket = perStage.get(stage)!;
    return { stage, prospects: bucket.all.size, verifiedProspects: bucket.verified.size };
  });

  const stageConversions: StageConversion[] = [];
  for (let i = 0; i < GTM_STAGES.length - 1; i++) {
    const from = GTM_STAGES[i]!;
    const to = GTM_STAGES[i + 1]!;
    const fromCount = perStage.get(from)!.all.size;
    const toCount = perStage.get(to)!.all.size;
    stageConversions.push({
      from,
      to,
      rate: fromCount > 0 ? clamp(toCount / fromCount, 0, 1) : 0,
    });
  }

  return { stages, stageConversions, totalProspects: allProspects.size };
}
