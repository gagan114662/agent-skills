import type {
  PortfolioAssessment,
  PortfolioDecision,
  PortfolioEvidence,
  PortfolioThresholds,
} from "./types.js";

/**
 * The Portfolio Lifecycle decision core (#107, ADR-0107). **Pure + unit-tested**: the service does the
 * IO (gather the KPI evidence, persist the review, gate the SUNSET); these functions turn a venture's
 * evidence into a 0–100 health score and one of the four decisions — the deterministic core, the
 * #96 `decide.ts` / #103 `score.ts` split. No IO, no clock (`ageInDays` is passed in).
 */

/** Clamp `n` into `[lo,hi]`, treating NaN as `lo`. */
function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * The bounded demand sub-score (0–100): each external willingness-to-pay signal (#101) is worth
 * `demandSignalPoints`, saturating at 100 — a handful of real signals already proves demand; the
 * 100th doesn't prove more. Negative counts clamp to 0.
 */
export function demandSubscore(demandSignals: number, demandSignalPoints: number): number {
  const signals = Math.max(0, Math.trunc(demandSignals));
  return clamp(signals * demandSignalPoints, 0, 100);
}

/**
 * The 0–100 composite portfolio-health score: the weight-normalized mean of the growth score (#102),
 * the moat score (#103), and the bounded demand sub-score (#101). Weights need not sum to 1 (they're
 * normalized by their own sum); all-zero weights yield 0 (no divide-by-zero). Inputs are clamped to
 * `[0,100]` so an out-of-range upstream score can't blow the composite past its bounds.
 */
export function portfolioHealth(
  evidence: PortfolioEvidence,
  thresholds: PortfolioThresholds,
): number {
  const growth = clamp(evidence.growthScore, 0, 100);
  const moat = clamp(evidence.moatScore, 0, 100);
  const demand = demandSubscore(evidence.demandSignals, thresholds.demandSignalPoints);
  const wg = Math.max(0, thresholds.weightGrowth);
  const wm = Math.max(0, thresholds.weightMoat);
  const wd = Math.max(0, thresholds.weightDemand);
  const sum = wg + wm + wd;
  if (sum <= 0) return 0;
  const composite = (wg * growth + wm * moat + wd * demand) / sum;
  return clamp(composite, 0, 100);
}

/**
 * Decide a launched venture's fate from its KPI evidence, by the ladder (first match wins) — the kill
 * discipline #107 brings to launched products:
 *   1. grace — a launch younger than `minReviewAgeDays` holds at MAINTAIN (too early to judge);
 *   2. DOUBLE_DOWN — health ≥ `doubleDownScore` AND traction (real revenue or demand);
 *   3. SUNSET (low health) — health ≤ `sunsetScore`;
 *   4. SUNSET (burning) — spending on infra with zero traction (the economic kill);
 *   5. PIVOT — moat stagnant + no traction but not burning (cheap to re-enter #96 with learnings);
 *   6. MAINTAIN — the healthy middle.
 * `hasTraction = revenue > 0 || demandSignals > 0`; `netCents = revenue − cost`. Pure + deterministic.
 */
export function decidePortfolio(
  evidence: PortfolioEvidence,
  thresholds: PortfolioThresholds,
): PortfolioAssessment {
  const score = portfolioHealth(evidence, thresholds);
  const netCents = evidence.revenueCents - evidence.monthlyCostCents;
  const hasTraction = evidence.revenueCents > 0 || evidence.demandSignals > 0;
  const burningWithoutTraction = evidence.monthlyCostCents > 0 && !hasTraction;

  let decision: PortfolioDecision;
  const reasons: string[] = [];

  if (evidence.ageInDays < thresholds.minReviewAgeDays) {
    decision = "MAINTAIN";
    reasons.push(
      `only ${evidence.ageInDays}d since launch — inside the ${thresholds.minReviewAgeDays}d grace window`,
    );
  } else if (score >= thresholds.doubleDownScore && hasTraction) {
    decision = "DOUBLE_DOWN";
    reasons.push(
      `health ${score.toFixed(0)} ≥ ${thresholds.doubleDownScore} with traction — invest more`,
    );
  } else if (score <= thresholds.sunsetScore) {
    decision = "SUNSET";
    reasons.push(`health ${score.toFixed(0)} ≤ ${thresholds.sunsetScore} — sunset candidate`);
  } else if (burningWithoutTraction) {
    decision = "SUNSET";
    reasons.push(
      `burning ${evidence.monthlyCostCents}¢/window with no traction (no revenue, no demand) — sunset`,
    );
  } else if (evidence.moatStagnant && !hasTraction) {
    decision = "PIVOT";
    reasons.push("moat stagnant and no traction, but cheap — pivot (re-enter #96 with learnings)");
  } else {
    decision = "MAINTAIN";
    reasons.push(`health ${score.toFixed(0)} with traction — maintain`);
  }

  // Supporting context (after the decisive reason), useful on the dashboard.
  if (evidence.moatStagnant && decision !== "PIVOT") reasons.push("moat is stagnant (#103)");
  if (netCents < 0 && decision !== "SUNSET") reasons.push(`net ${netCents}¢ (burning)`);

  return { ventureIdeaId: evidence.ventureIdeaId, decision, score, netCents, hasTraction, reasons };
}
