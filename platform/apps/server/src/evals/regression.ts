/**
 * Pure regression math (#155, ADR-0155 §4). Turns a list of case verdicts into a suite summary, and
 * compares a current summary against a committed baseline to decide whether the build regressed. This is
 * the maintenance latch the playbook calls for (skills drift 95% → 65% silently unless a number is watched);
 * the `regressed` verdict is what fails CI and what feeds the #117 flywheel. No IO, no clock.
 */

import type { EvalCaseResult, EvalRunSummary } from "./types.js";

/** Roll up case verdicts into a suite summary. `passRate` is 0 for an empty suite. */
export function summarizeRun(agent: string, version: string, results: EvalCaseResult[]): EvalRunSummary {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  return {
    agent,
    version,
    total,
    passed,
    failed,
    passRate: total > 0 ? passed / total : 0,
    results,
  };
}

/** A single baseline entry (what `baseline.json` stores per agent). */
export interface EvalBaselineEntry {
  agent: string;
  version: string;
  passRate: number;
}

/** The before/after verdict surfaced in the PR description and fed to the flywheel. */
export interface RegressionVerdict {
  agent: string;
  baselineRate: number;
  currentRate: number;
  /** current − baseline (negative ⇒ worse). */
  delta: number;
  /** True when the drop exceeds `tolerance` (a real regression, not float noise). */
  regressed: boolean;
  /** True when the current rate improved beyond `tolerance` (used to bump the baseline). */
  improved: boolean;
}

/**
 * Compare a current run against its baseline. `tolerance` (e.g. 0.0) is the allowed slip before we call
 * it a regression — a drop strictly greater than `tolerance` regresses. A missing baseline is treated as
 * 0 (any passing run is an improvement, never a regression — first run can't regress).
 */
export function compareRuns(
  baseline: EvalBaselineEntry | undefined,
  current: EvalRunSummary,
  tolerance: number,
): RegressionVerdict {
  const baselineRate = baseline?.passRate ?? 0;
  const delta = current.passRate - baselineRate;
  const tol = Math.max(0, tolerance);
  return {
    agent: current.agent,
    baselineRate,
    currentRate: current.passRate,
    delta,
    regressed: delta < -tol,
    improved: delta > tol,
  };
}

/** Format one verdict as a markdown table row for the PR description's before/after delta. */
export function verdictRow(v: RegressionVerdict): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const arrow = v.regressed ? "🔴" : v.improved ? "🟢" : "⚪️";
  const sign = v.delta >= 0 ? "+" : "";
  return `| ${v.agent} | ${pct(v.baselineRate)} | ${pct(v.currentRate)} | ${sign}${(v.delta * 100).toFixed(1)}pp | ${arrow} |`;
}
