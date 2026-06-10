import { relaxableAction, type RelaxableActionType } from "./invariants.js";

/**
 * The Evidence-Priced Autonomy pricer (#119, ADR-0119). **Pure and dependency-free** so it runs in the
 * no-DB unit job and is the single source of truth for "should this action class's human gate move?".
 * Persistence, policy mutation, and audit live in `service.ts`; this only decides — the same pure-core
 * split as #13 `evaluatePolicy`, #17 `decideWorkflowAction`, #96 `decideVenture`, #105 `decideRevival`.
 */

/** A recorded human-decision outcome — the unit of evidence. */
export type Outcome = "approved" | "rejected" | "edited";
export const OUTCOMES: readonly Outcome[] = ["approved", "rejected", "edited"];

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

/** The trailing-window roll-up the decision is priced on. */
export interface WindowSummary {
  total: number;
  approved: number;
  rejected: number;
  edited: number;
  /**
   * Fraction of decisions that required human correction — `(rejected + edited) / total`. An
   * approved-as-is decision means the agent got it right; a reject or an edit means it did not. `0`
   * for an empty window (never `NaN`).
   */
  errorRate: number;
}

/** Roll a list of trailing outcomes (any order) into the summary the pricer consumes. Pure. */
export function summarizeWindow(outcomes: Outcome[]): WindowSummary {
  const total = outcomes.length;
  const approved = outcomes.filter((o) => o === "approved").length;
  const rejected = outcomes.filter((o) => o === "rejected").length;
  const edited = outcomes.filter((o) => o === "edited").length;
  const errorRate = total === 0 ? 0 : (rejected + edited) / total;
  return { total, approved, rejected, edited, errorRate };
}

/**
 * The two hysteresis rails + the evidence floor. `relaxBelowRate` is strictly below
 * `retightenAboveRate`, so the band between them is a dead zone where the boundary HOLDs whichever side
 * it is on — that is what makes the boundary unable to flap. `minSamples` is the evidence a *strict*
 * boundary must accumulate before it may relax at all.
 */
export interface PricingThresholds {
  /** Minimum decisions in the trailing window before a RELAX is allowed (the insufficient-evidence guard). */
  minSamples: number;
  /** Error rate **strictly below** which a strict boundary RELAXes. (e.g. 0.05) */
  relaxBelowRate: number;
  /** Error rate **strictly above** which a relaxed boundary RE-TIGHTENs. (e.g. 0.15) */
  retightenAboveRate: number;
}

export type Recommendation = "RELAX" | "RETIGHTEN" | "HOLD";

export interface GatePricingInput {
  /** The approval action class being priced. */
  actionType: string;
  /** The trailing-window roll-up. */
  window: WindowSummary;
  /** Whether a #95 auto-approve rule currently exists for this class (the boundary's current side). */
  currentlyRelaxed: boolean;
  thresholds: PricingThresholds;
}

/** Fields every decision carries, whatever the recommendation. */
interface DecisionBase {
  errorRate: number;
  windowSize: number;
  reason: string;
}

/**
 * The RELAX recommendation carries a {@link RelaxableActionType} — a value the compiler will only
 * grant for a NON-invariant class. This is the structural guarantee: a `RELAX` for an invariant class
 * cannot be constructed, so it cannot be returned (proven by a `@ts-expect-error` unit test).
 */
export interface RelaxDecision extends DecisionBase {
  recommendation: "RELAX";
  action: RelaxableActionType;
}

export interface RetightenDecision extends DecisionBase {
  recommendation: "RETIGHTEN";
  actionType: string;
}

export interface HoldDecision extends DecisionBase {
  recommendation: "HOLD";
  actionType: string;
}

export type GatePricingDecision = RelaxDecision | RetightenDecision | HoldDecision;

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * Decide whether an action class's human gate should move, given its trailing window, current side,
 * and the rails. Total and pure. Order (hard stops first):
 *   1. **invariant class** → never RELAX. RETIGHTEN if it is somehow currently relaxed, else HOLD.
 *   2. **currently relaxed** → RETIGHTEN only above the (higher) re-tighten rail, else HOLD.
 *   3. **currently strict** → HOLD without enough evidence; RELAX only below the (lower) relax rail,
 *      else HOLD.
 * The gap between the two rails is the hysteresis dead band: the boundary cannot flap on a small wobble.
 */
export function decideGatePricing(input: GatePricingInput): GatePricingDecision {
  const { actionType, window, currentlyRelaxed, thresholds } = input;
  const base: DecisionBase = {
    errorRate: window.errorRate,
    windowSize: window.total,
    reason: "",
  };

  const relaxable = relaxableAction(actionType);
  if (relaxable === null) {
    // (1) Invariant class — can NEVER auto-relax, regardless of how clean the window is.
    if (currentlyRelaxed) {
      return {
        ...base,
        recommendation: "RETIGHTEN",
        actionType,
        reason: "invariant class must never be relaxed — re-tightening",
      };
    }
    return {
      ...base,
      recommendation: "HOLD",
      actionType,
      reason: "invariant class: auto-relax is forbidden",
    };
  }

  if (currentlyRelaxed) {
    // (2) Relaxed boundary: only climb back to a human once error exceeds the upper rail.
    if (window.errorRate > thresholds.retightenAboveRate) {
      return {
        ...base,
        recommendation: "RETIGHTEN",
        actionType,
        reason: `error rate ${pct(window.errorRate)} exceeds re-tighten threshold ${pct(
          thresholds.retightenAboveRate,
        )}`,
      };
    }
    return {
      ...base,
      recommendation: "HOLD",
      actionType,
      reason: "relaxed boundary holds — error within tolerance",
    };
  }

  // (3) Strict boundary: needs both enough evidence and a low error rate to earn a relax.
  if (window.total < thresholds.minSamples) {
    return {
      ...base,
      recommendation: "HOLD",
      actionType,
      reason: `insufficient evidence (${window.total}/${thresholds.minSamples} decisions)`,
    };
  }
  if (window.errorRate < thresholds.relaxBelowRate) {
    return {
      ...base,
      recommendation: "RELAX",
      action: relaxable,
      reason: `error rate ${pct(window.errorRate)} below relax threshold ${pct(
        thresholds.relaxBelowRate,
      )} over ${window.total} decisions`,
    };
  }
  return {
    ...base,
    recommendation: "HOLD",
    actionType,
    reason: "strict boundary holds — error not low enough to relax",
  };
}

/**
 * Levenshtein edit distance between two strings — the drafted-content correction measure recorded when
 * a human edits an agent's draft before approving. Pure; iterative two-row DP (O(min)·space).
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Single rolling row + a diagonal tracker (O(n) space). The `?? 0` defaults are never reached — every
  // index is in range — they just satisfy `noUncheckedIndexedAccess`.
  const row: number[] = [];
  for (let j = 0; j <= n; j++) row.push(j);
  for (let i = 1; i <= m; i++) {
    let diag = row[0] ?? 0; // value at (i-1, j-1)
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const up = row[j] ?? 0; // value at (i-1, j) before overwrite
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(up + 1, (row[j - 1] ?? 0) + 1, diag + cost);
      diag = up;
    }
  }
  return row[n] ?? 0;
}
