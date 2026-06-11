import { is2xx, meetsAtLeast, noRecurrence } from "./guards.js";
import {
  VERIFIER_KINDS,
  type Observation,
  type VerifierClaim,
  type VerifierKind,
  type VerifierOutcome,
  type VerifierResultRecord,
} from "./types.js";

/**
 * The pure verifier registry (#106, ADR-0106 §1). One function per {@link VerifierKind}, each turning a
 * measured {@link Observation} into a {@link VerifierOutcome} against the claim's `target`. **No IO, no
 * clock, no randomness**: a given (claim, observation) always yields the same verdict — that determinism
 * is what makes "the gate is measured" a property of the code rather than a hope. The IO `engine` does
 * the measuring + persisting; this file does only the judging.
 */

/** A pure verifier: judge a measured observation against the claim. */
type Verifier = (claim: VerifierClaim, observation: Observation) => VerifierOutcome;

const verifiers: Record<VerifierKind, Verifier> = {
  /** Live + 2xx ⇒ the deploy is actually reachable. The measured value is the HTTP status. */
  deploy_live: (_claim, o) => {
    if (o.kind !== "deploy_live") throw new Error("deploy_live verifier got mismatched observation");
    const passed = o.healthy && is2xx(o.httpStatus);
    return {
      passed,
      measuredValue: o.httpStatus,
      threshold: 200,
      detail: passed
        ? `deploy live: HTTP ${o.httpStatus}, healthy`
        : `deploy NOT live: HTTP ${o.httpStatus}, healthy=${o.healthy}`,
    };
  },

  /** At least `target` SETTLED revenue events landed ⇒ real money, not a fake-door click. */
  revenue_real: (claim, o) => {
    if (o.kind !== "revenue_real") throw new Error("revenue_real verifier got mismatched observation");
    const target = Math.max(1, claim.target);
    const passed = meetsAtLeast(o.realEventCount, target);
    return {
      passed,
      measuredValue: o.realEventCount,
      threshold: target,
      detail: passed
        ? `revenue real: ${o.realEventCount} settled event(s) ≥ ${target}`
        : `revenue NOT real: ${o.realEventCount} settled event(s) < ${target}`,
    };
  },

  /** The metric moved by at least `target` from its baseline ⇒ a real move, not noise. */
  growth_metric: (claim, o) => {
    if (o.kind !== "growth_metric") throw new Error("growth_metric verifier got mismatched observation");
    const delta = o.currentValue - o.baselineValue;
    const passed = meetsAtLeast(delta, claim.target);
    return {
      passed,
      measuredValue: delta,
      threshold: claim.target,
      detail: passed
        ? `growth moved: Δ${delta} (${o.baselineValue}→${o.currentValue}) ≥ ${claim.target}`
        : `growth flat: Δ${delta} (${o.baselineValue}→${o.currentValue}) < ${claim.target}`,
    };
  },

  /** Zero recurrences since the fix landed ⇒ the fix held (the FINAL verifier). */
  fix_held: (_claim, o) => {
    if (o.kind !== "fix_held") throw new Error("fix_held verifier got mismatched observation");
    const passed = noRecurrence(o.recurrenceCount);
    return {
      passed,
      measuredValue: o.recurrenceCount,
      threshold: 0,
      detail: passed
        ? "fix held: 0 recurrences since the fix landed"
        : `fix did NOT hold: ${o.recurrenceCount} recurrence(s) since the fix landed`,
    };
  },
};

/** Dispatch a claim to its pure verifier. Throws on an unknown/mismatched kind (a programming error). */
export function evaluateClaim(claim: VerifierClaim, observation: Observation): VerifierOutcome {
  const verifier = verifiers[claim.kind];
  if (!verifier) throw new Error(`no verifier registered for kind: ${String(claim.kind)}`);
  if (observation.kind !== claim.kind) {
    throw new Error(`observation kind ${observation.kind} does not match claim kind ${claim.kind}`);
  }
  return verifier(claim, observation);
}

// ---- consumption reducer (pure) ----------------------------------------------------------------

/** The shared outcome summary #96 / #117 / #119 read off a window of evidence rows. */
export interface OutcomeEvidenceSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  /** passed ÷ (passed + failed) over measured (non-errored) rows; 0 when none measured. */
  passRate: number;
  /** The latest status per `kind|claimRef`, newest-first input assumed → first seen wins. */
  latestByClaim: Record<string, VerifierResultRecord["status"]>;
}

/**
 * Reduce a window of evidence rows (any order; pass newest-first for a correct `latestByClaim`) to the
 * signal the venture scorecard (#96), the flywheel (#117), and the autonomy pricer (#119) consume. Pure
 * — the repo supplies the rows, this does the math.
 */
export function summarizeOutcomeEvidence(rows: VerifierResultRecord[]): OutcomeEvidenceSummary {
  let passed = 0;
  let failed = 0;
  let errored = 0;
  const latestByClaim: Record<string, VerifierResultRecord["status"]> = {};
  for (const r of rows) {
    if (r.status === "passed") passed += 1;
    else if (r.status === "failed") failed += 1;
    else errored += 1;
    const key = `${r.kind}|${r.claimRef}`;
    if (!(key in latestByClaim)) latestByClaim[key] = r.status;
  }
  const measured = passed + failed;
  return {
    total: rows.length,
    passed,
    failed,
    errored,
    passRate: measured > 0 ? passed / measured : 0,
    latestByClaim,
  };
}

/** The registered kinds — exported so callers can enumerate the registry. */
export const REGISTERED_KINDS = VERIFIER_KINDS;
