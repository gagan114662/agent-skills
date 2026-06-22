/**
 * Lead scoring (issue #611) — pure data shapes. No IO, no clock, no randomness.
 *
 * The problem: agents treat every lead the same and burn effort on low-intent ones. The fix is an
 * **intent score** built from two independent axes:
 *
 *   - BEHAVIOR (what the prospect did): pricing-page visits, demo/sandbox use, email opens/clicks. This is
 *     the hand-raise — the strongest predictor of buying intent — so it dominates the score (up to 60 pts).
 *   - FIRMOGRAPHICS (who the prospect is): company size, revenue, ICP industry fit, the contact's role, and
 *     region. This is FIT, not intent, so it is the secondary axis (up to 40 pts).
 *
 * The outreach queue is then ordered by that single 0–100 score, highest first, and — crucially for #611 —
 * every score is **explainable**: it carries the exact list of contributing factors, each with its point
 * value and a human-readable reason, so an agent (or a human reviewer) can see *why* a lead ranked where it
 * did. Nothing here is a black box.
 *
 * Like the #674 content-guard and #670 budget-governor modules, this is a self-contained pure library: it
 * does no IO and wires into no route, schema barrel, or migration. Callers feed it DATA and get DATA back.
 */

/**
 * Observed behavior signals for a lead over the scoring lookback window. Every field is OPTIONAL — a lead we
 * know nothing about simply scores 0 on that factor (absence is treated as "no signal", never as a negative).
 * Counts are non-negative; the scorer saturates each at a diminishing-returns point so one hyperactive metric
 * cannot run away with the whole score.
 */
export interface BehaviorSignals {
  /** Visits to the pricing page — the single strongest in-product buying signal. */
  pricingVisits?: number;
  /** Demo / sandbox sessions started (#610 instant-demo is the obvious producer of this signal). */
  demoSessions?: number;
  /** Total minutes spent in the demo/sandbox — depth of engagement, not just that they opened it. */
  demoMinutes?: number;
  /** Clicks inside marketing/sequence emails — a stronger signal than a mere open. */
  emailClicks?: number;
  /** Marketing/sequence email opens. */
  emailOpens?: number;
  /** General site sessions (blog, docs, home) — a weak top-of-funnel signal. */
  siteVisits?: number;
  /**
   * Days since the lead's most recent tracked activity. Recency decays the behavior subtotal: a flurry of
   * pricing visits three months ago is far weaker intent than the same activity last week. `undefined` means
   * "recency unknown" and applies no decay (we never penalize for missing data).
   */
  daysSinceLastActivity?: number;
}

/** ICP industry match for the lead's company. */
export type IndustryFit = "core" | "adjacent" | "off" | "unknown";

/** The contact's buying role — how much authority they carry in the deal. */
export type BuyingRole = "decision_maker" | "champion" | "influencer" | "end_user" | "unknown";

/** Geographic fit against the markets we can actually serve. */
export type RegionFit = "core" | "expansion" | "unsupported" | "unknown";

/**
 * Firmographic attributes of the lead's company + contact. All OPTIONAL; an unknown attribute contributes 0.
 * Unlike behavior, a few firmographic factors can be NEGATIVE (an off-ICP industry, an unsupported region) —
 * a genuinely poor fit should be able to pull a noisy-but-irrelevant lead down the queue.
 */
export interface Firmographics {
  /** Company headcount. */
  employeeCount?: number;
  /** Company annual revenue in USD. */
  annualRevenueUsd?: number;
  /** ICP industry match. */
  industryFit?: IndustryFit;
  /** The contact's buying role. */
  role?: BuyingRole;
  /** Geographic fit. */
  region?: RegionFit;
}

/** One lead handed to the scorer. `leadId` is an opaque, stable key (never PII — mirrors the #400 leads centre). */
export interface LeadInput {
  leadId: string;
  behavior?: BehaviorSignals;
  firmographics?: Firmographics;
}

/** Which axis a factor belongs to — lets a UI group the explanation into "intent" vs "fit". */
export type ScoreCategory = "behavior" | "firmographics";

/**
 * A single line of the explanation: one factor's contribution to the score. `points` is signed (firmographic
 * fit factors can be negative), and the sum of every factor's `points` equals `behaviorScore + firmographicScore`
 * (the pre-clamp subtotal) — this invariant is what makes the score auditable rather than a magic number.
 */
export interface ScoreFactor {
  /** Stable machine key, e.g. `pricing_visits`, `industry_fit`, `recency`. */
  key: string;
  /** Human-readable label for a UI or an agent's reasoning, e.g. "Pricing-page visits". */
  label: string;
  /** Which axis this factor scored on. */
  category: ScoreCategory;
  /** Signed contribution to the score, in points. */
  points: number;
  /** Why these points were awarded, e.g. "3 visits (saturates at 3)". */
  detail: string;
}

/** Coarse intent band derived from the final score — the bucket an agent sees at a glance. */
export type IntentBand = "hot" | "warm" | "cool" | "cold";

/**
 * The explainable result of scoring one lead. `score` is the clamped 0–100 intent score the queue orders by;
 * `factors` is the full, point-attributed explanation (already sorted by absolute impact, descending).
 */
export interface LeadScore {
  leadId: string;
  /** Final intent score, clamped to 0–100. The queue's sort key. */
  score: number;
  /** Coarse band derived from {@link score}. */
  band: IntentBand;
  /** Behavior (intent) subtotal after recency decay, 0–60. */
  behaviorScore: number;
  /** Firmographic (fit) subtotal, may be negative; capped at +40. */
  firmographicScore: number;
  /** The full explanation: every contributing factor, sorted by absolute point impact (desc). */
  factors: ScoreFactor[];
  /** One-line natural-language summary of the top drivers — the headline of the explanation. */
  summary: string;
}
