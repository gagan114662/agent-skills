/**
 * Shared types for the Portfolio Lifecycle Loop (#107, ADR-0107). The pure `decide` module and the IO
 * `service`/`default` agree on these — mirroring the #96 venture / #103 moat `types.ts` split
 * (const-tuple taxonomies + `is*` guards, the row-mirroring record, the pure evidence/assessment
 * structs the decision core consumes).
 */

/**
 * The four portfolio decisions — kill discipline for LAUNCHED ventures (not just ideas). `DOUBLE_DOWN`
 * invests more (emit growth tasks); `MAINTAIN` holds; `PIVOT` re-enters the Venture Loop (#96) with the
 * learnings; `SUNSET` kills the venture (human-gated via #13). Each is a CHECK value on `decision`.
 */
export const PORTFOLIO_DECISIONS = ["DOUBLE_DOWN", "MAINTAIN", "PIVOT", "SUNSET"] as const;
export type PortfolioDecision = (typeof PORTFOLIO_DECISIONS)[number];

export function isPortfolioDecision(value: unknown): value is PortfolioDecision {
  return typeof value === "string" && (PORTFOLIO_DECISIONS as readonly string[]).includes(value);
}

/** Lifecycle of a review row — a SUNSET decision moves `recorded → sunset_pending → executed/rejected`. */
export const PORTFOLIO_REVIEW_STATUSES = [
  "recorded",
  "sunset_pending",
  "sunset_executed",
  "sunset_rejected",
] as const;
export type PortfolioReviewStatus = (typeof PORTFOLIO_REVIEW_STATUSES)[number];

export function isPortfolioReviewStatus(value: unknown): value is PortfolioReviewStatus {
  return (
    typeof value === "string" && (PORTFOLIO_REVIEW_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Thresholds + weights that parameterize the pure decision — supplied from config (`resolvePortfolioCaps`).
 * These ARE the per-venture "targets" the review judges against (the tenant's layered, lockable policy;
 * #96 stores no FUND-time target — see ADR-0107).
 */
export interface PortfolioThresholds {
  /** Composite health (0–100) at/above which a venture earns more investment (with traction). */
  doubleDownScore: number;
  /** Composite health (0–100) at/below which a venture is a sunset candidate. */
  sunsetScore: number;
  /** Days since launch below which the loop holds at MAINTAIN (too early to judge a fresh launch). */
  minReviewAgeDays: number;
  /** Per-signal points for the bounded demand sub-score (capped at 100). */
  demandSignalPoints: number;
  /** Weight on the growth score in the composite (≥ 0; weights need not sum to 1 — they're normalized). */
  weightGrowth: number;
  /** Weight on the moat score in the composite (≥ 0). */
  weightMoat: number;
  /** Weight on the demand sub-score in the composite (≥ 0). */
  weightDemand: number;
}

/**
 * The gathered KPI snapshot for one launched venture — the input the pure decision reads. Growth (#102)
 * and moat (#103) are already-computed 0–100 scores; `demandSignals` is the count of external
 * willingness-to-pay signals (#101); revenue (#98) is workspace-level cents; cost is the current
 * window's infra burn (#71 `tenant_usage`); `ageInDays` is days since the venture launched (FUND).
 */
export interface PortfolioEvidence {
  ventureIdeaId: string;
  /** 0–100 growth score (#102). */
  growthScore: number;
  /** 0–100 moat score (#103). */
  moatScore: number;
  /** True when the venture's moat has stopped compounding (#103 stagnation flag). */
  moatStagnant: boolean;
  /** Count of external demand signals earned (#101). */
  demandSignals: number;
  /** Workspace revenue in cents (#98). */
  revenueCents: number;
  /** Current-window infra cost in cents (#71 `tenant_usage`). */
  monthlyCostCents: number;
  /** Days since the venture launched (FUND). */
  ageInDays: number;
}

/** The pure decision output for one venture — the decision, the score it was made on, and why. */
export interface PortfolioAssessment {
  ventureIdeaId: string;
  decision: PortfolioDecision;
  /** 0–100 composite portfolio-health score. */
  score: number;
  /** Net economics: `revenueCents − monthlyCostCents` (negative = burning). */
  netCents: number;
  /** Whether the venture earns money or has real external demand (the traction gate). */
  hasTraction: boolean;
  /** Human-readable reasons, in priority order (the first is the decisive one). */
  reasons: string[];
}

/** One persisted review (one row in `portfolio_reviews`) — the evidence snapshot + decision + lifecycle. */
export interface PortfolioReviewRecord {
  id: string;
  workspaceId: string;
  ventureIdeaId: string;
  decision: PortfolioDecision;
  /** 0–100 composite health at review time. */
  score: number;
  growthScore: number;
  moatScore: number;
  moatStagnant: boolean;
  demandSignals: number;
  revenueCents: number;
  monthlyCostCents: number;
  /** `revenueCents − monthlyCostCents` at review time. */
  netCents: number;
  ageInDays: number;
  reasons: string[];
  status: PortfolioReviewStatus;
  /** The #13 approval request gating a SUNSET (soft reference), or null. */
  approvalRequestId: string | null;
  createdByMemberId: string | null;
  createdAt: Date;
}
