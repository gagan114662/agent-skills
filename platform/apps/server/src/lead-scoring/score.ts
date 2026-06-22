/**
 * Lead scoring model + scorer (issue #611). Pure: `scoreLead` is a deterministic function of its input —
 * same lead in, same {@link LeadScore} out, every time. No clock, no randomness, no IO.
 *
 * The model is intentionally legible (a weighted, saturating linear model) rather than opaque, because the
 * acceptance criterion is that the score is EXPLAINABLE. Each factor contributes a bounded number of points
 * with a documented reason, and the returned `factors` list is the literal audit trail of the number.
 *
 * Axis budgets: BEHAVIOR (intent) tops out at {@link BEHAVIOR_MAX} = 60, FIRMOGRAPHICS (fit) at
 * {@link FIRMO_MAX} = 40, so a perfect lead scores 100. Intent outweighs fit by design — a hand-raise beats a
 * pretty logo.
 */

import type {
  BehaviorSignals,
  Firmographics,
  IntentBand,
  LeadInput,
  LeadScore,
  ScoreFactor,
} from "./types.js";

/** Maximum points the behavior (intent) axis can contribute. */
export const BEHAVIOR_MAX = 60;
/** Maximum points the firmographic (fit) axis can contribute. */
export const FIRMO_MAX = 40;

/** A behavior factor: `weight` points awarded, scaled by how far `value` has climbed toward `saturateAt`. */
interface BehaviorWeight {
  key: string;
  label: string;
  /** Max points this factor can add (reached once the count hits `saturateAt`). */
  weight: number;
  /** The count at which the factor is fully "earned"; beyond it adds nothing (diminishing returns). */
  saturateAt: number;
  read: (b: BehaviorSignals) => number | undefined;
}

/**
 * The behavior model. Weights sum to exactly {@link BEHAVIOR_MAX} (60), so a lead saturated on every signal
 * earns the full intent budget. Ordered strongest-intent-first; the ordering is documentation, not logic.
 */
export const BEHAVIOR_WEIGHTS: readonly BehaviorWeight[] = [
  { key: "pricing_visits", label: "Pricing-page visits", weight: 20, saturateAt: 3, read: (b) => b.pricingVisits },
  { key: "demo_sessions", label: "Demo sessions", weight: 14, saturateAt: 2, read: (b) => b.demoSessions },
  { key: "demo_minutes", label: "Demo minutes", weight: 8, saturateAt: 15, read: (b) => b.demoMinutes },
  { key: "email_clicks", label: "Email clicks", weight: 8, saturateAt: 3, read: (b) => b.emailClicks },
  { key: "email_opens", label: "Email opens", weight: 6, saturateAt: 5, read: (b) => b.emailOpens },
  { key: "site_visits", label: "Site visits", weight: 4, saturateAt: 6, read: (b) => b.siteVisits },
];

/** A recency tier: activity within `maxDays` decays the behavior subtotal by `multiplier`. Ascending by `maxDays`. */
interface RecencyTier {
  maxDays: number;
  multiplier: number;
  label: string;
}

/**
 * Recency decay applied to the behavior subtotal. Recent intent is worth full value; stale intent is
 * progressively discounted. `Infinity` is the catch-all oldest tier.
 */
export const RECENCY_TIERS: readonly RecencyTier[] = [
  { maxDays: 7, multiplier: 1, label: "within the last week" },
  { maxDays: 30, multiplier: 0.8, label: "in the last month" },
  { maxDays: 90, multiplier: 0.5, label: "in the last quarter" },
  { maxDays: Infinity, multiplier: 0.25, label: "over a quarter ago" },
];

/** Final-score → band thresholds (inclusive lower bounds), checked high-to-low. */
const BAND_THRESHOLDS: ReadonlyArray<{ min: number; band: IntentBand }> = [
  { min: 70, band: "hot" },
  { min: 45, band: "warm" },
  { min: 20, band: "cool" },
  { min: 0, band: "cold" },
];

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** A non-negative count from untrusted/optional input: coerce non-finite or negative values to 0. */
function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function bandFor(score: number): IntentBand {
  // BAND_THRESHOLDS always ends at min 0, so this never falls through; the ?? keeps the type non-undefined.
  return BAND_THRESHOLDS.find((t) => score >= t.min)?.band ?? "cold";
}

/** Resolve the recency multiplier + the tier that produced it. `undefined` days → no decay (full value). */
function resolveRecency(days: number | undefined): { multiplier: number; tier: RecencyTier | null } {
  if (days === undefined || !Number.isFinite(days)) return { multiplier: 1, tier: null };
  const d = Math.max(0, days);
  const tier = RECENCY_TIERS.find((t) => d <= t.maxDays) ?? RECENCY_TIERS[RECENCY_TIERS.length - 1] ?? null;
  return { multiplier: tier ? tier.multiplier : 1, tier };
}

/** Score the behavior (intent) axis, returning its post-decay subtotal and the per-factor explanation. */
function scoreBehavior(behavior: BehaviorSignals | undefined): {
  subtotal: number;
  factors: ScoreFactor[];
} {
  const b = behavior ?? {};
  const factors: ScoreFactor[] = [];
  let raw = 0;

  for (const w of BEHAVIOR_WEIGHTS) {
    const value = count(w.read(b));
    if (value === 0) continue;
    const ratio = Math.min(value / w.saturateAt, 1);
    const points = Math.round(w.weight * ratio);
    if (points === 0) continue;
    raw += points;
    factors.push({
      key: w.key,
      label: w.label,
      category: "behavior",
      points,
      detail:
        value >= w.saturateAt
          ? `${value} (saturates at ${w.saturateAt}, full ${w.weight} pts)`
          : `${value} of ${w.saturateAt} for full credit`,
    });
  }

  // Recency decays the whole intent subtotal. Expressed as its own (negative) factor so the explanation's
  // points still sum to the subtotal — the auditability invariant the acceptance test pins.
  const { multiplier, tier } = resolveRecency(b.daysSinceLastActivity);
  const decayed = Math.round(raw * multiplier);
  if (raw > 0 && decayed !== raw) {
    factors.push({
      key: "recency",
      label: "Recency decay",
      category: "behavior",
      points: decayed - raw,
      detail: `last active ${tier ? tier.label : "recently"} (×${multiplier})`,
    });
  }

  return { subtotal: decayed, factors };
}

/** Tiered lookup: first tier whose `max` the value does not exceed wins. Tiers ascending by `max`. */
function tier(
  value: number,
  tiers: ReadonlyArray<{ max: number; points: number; label: string }>,
): { points: number; label: string } | null {
  return tiers.find((t) => value <= t.max) ?? null;
}

const EMPLOYEE_TIERS = [
  { max: 10, points: 2, label: "1–10 employees (very small)" },
  { max: 50, points: 5, label: "11–50 employees" },
  { max: 250, points: 8, label: "51–250 employees (sweet spot)" },
  { max: 1000, points: 7, label: "251–1,000 employees" },
  { max: 5000, points: 6, label: "1,001–5,000 employees" },
  { max: Infinity, points: 4, label: "5,000+ employees (enterprise)" },
] as const;

const REVENUE_TIERS = [
  { max: 1_000_000, points: 1, label: "<$1M revenue" },
  { max: 10_000_000, points: 3, label: "$1M–$10M revenue" },
  { max: 100_000_000, points: 5, label: "$10M–$100M revenue (sweet spot)" },
  { max: Infinity, points: 4, label: "$100M+ revenue" },
] as const;

const INDUSTRY_POINTS: Record<NonNullable<Firmographics["industryFit"]>, number> = {
  core: 14,
  adjacent: 6,
  off: -8,
  unknown: 0,
};

const ROLE_POINTS: Record<NonNullable<Firmographics["role"]>, number> = {
  decision_maker: 10,
  champion: 7,
  influencer: 3,
  end_user: 0,
  unknown: 0,
};

const REGION_POINTS: Record<NonNullable<Firmographics["region"]>, number> = {
  core: 3,
  expansion: 2,
  unsupported: -6,
  unknown: 0,
};

/**
 * Score the firmographic (fit) axis. Positive contributions sum to at most {@link FIRMO_MAX} (40) by
 * construction (14 + 10 + 8 + 5 + 3), so no clamp adjustment factor is needed for the upper bound; the
 * subtotal can still go negative for a genuinely poor fit, which the final clamp absorbs.
 */
function scoreFirmographics(firmographics: Firmographics | undefined): {
  subtotal: number;
  factors: ScoreFactor[];
} {
  const f = firmographics ?? {};
  const factors: ScoreFactor[] = [];
  let subtotal = 0;

  const push = (key: string, label: string, points: number, detail: string): void => {
    if (points === 0) return;
    subtotal += points;
    factors.push({ key, label, category: "firmographics", points, detail });
  };

  if (f.industryFit && f.industryFit !== "unknown") {
    push("industry_fit", "Industry fit", INDUSTRY_POINTS[f.industryFit], `${f.industryFit} ICP industry`);
  }
  if (f.role && f.role !== "unknown") {
    push("role", "Buying role", ROLE_POINTS[f.role], `contact is a ${f.role.replace("_", " ")}`);
  }
  if (typeof f.employeeCount === "number" && Number.isFinite(f.employeeCount) && f.employeeCount > 0) {
    const t = tier(f.employeeCount, EMPLOYEE_TIERS);
    if (t) push("company_size", "Company size", t.points, t.label);
  }
  if (typeof f.annualRevenueUsd === "number" && Number.isFinite(f.annualRevenueUsd) && f.annualRevenueUsd > 0) {
    const t = tier(f.annualRevenueUsd, REVENUE_TIERS);
    if (t) push("revenue", "Company revenue", t.points, t.label);
  }
  if (f.region && f.region !== "unknown") {
    push("region", "Region fit", REGION_POINTS[f.region], `${f.region} region`);
  }

  // Defensive: hold the documented upper bound even if the model is later retuned past 40.
  if (subtotal > FIRMO_MAX) {
    const overflow = FIRMO_MAX - subtotal;
    factors.push({
      key: "fit_cap",
      label: "Fit cap",
      category: "firmographics",
      points: overflow,
      detail: `firmographic fit capped at ${FIRMO_MAX} pts`,
    });
    subtotal = FIRMO_MAX;
  }

  return { subtotal, factors };
}

/** Build the one-line headline of the explanation from the top positive drivers. */
function summarize(score: number, band: IntentBand, factors: ScoreFactor[]): string {
  const drivers = factors
    .filter((x) => x.points > 0)
    .slice(0, 3)
    .map((x) => x.label.toLowerCase());
  if (drivers.length === 0) return `Score ${score}/100 (${band}) — no positive intent or fit signals yet`;
  return `Score ${score}/100 (${band}) — driven by ${drivers.join(", ")}`;
}

/**
 * Score a single lead into an explainable {@link LeadScore}. The `factors` list is the full audit trail: its
 * `points` sum to `behaviorScore + firmographicScore` (the pre-clamp total), and `score` is that total
 * clamped to 0–100. Factors are returned sorted by absolute impact (desc) so the biggest reasons come first.
 */
export function scoreLead(lead: LeadInput): LeadScore {
  const behavior = scoreBehavior(lead.behavior);
  const firmo = scoreFirmographics(lead.firmographics);

  const factors = [...behavior.factors, ...firmo.factors].sort(
    (a, b) => Math.abs(b.points) - Math.abs(a.points),
  );
  const total = behavior.subtotal + firmo.subtotal;
  const score = clamp(total, 0, 100);
  const band = bandFor(score);

  return {
    leadId: lead.leadId,
    score,
    band,
    behaviorScore: behavior.subtotal,
    firmographicScore: firmo.subtotal,
    factors,
    summary: summarize(score, band, factors),
  };
}
