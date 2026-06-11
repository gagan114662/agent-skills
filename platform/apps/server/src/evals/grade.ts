/**
 * Pure graders (#155, ADR-0155 §4). One function per {@link GraderKind}, each judging an agent's actual
 * answer string against the case's `expected`. **No IO, no clock, no randomness** — the same (case, actual)
 * always yields the same verdict, which is what lets "the eval passed" be a property of the code. The IO
 * `service.ts` produces the `actual` (via the semantic layer or a skill check) and persists the verdict;
 * this file does only the judging. Mirrors `verifiers/registry.ts`.
 */

import type { EvalCase, EvalCaseResult, GraderKind } from "./types.js";

type Grader = (expected: string, actual: string, tolerance: number) => boolean;

const GRADERS: Record<GraderKind, Grader> = {
  /** Exact match after trimming + case-fold (answers are deterministic, so this is strict but fair). */
  exact: (expected, actual) => norm(actual) === norm(expected),

  /** The expected substring appears in the answer (case-insensitive). The workhorse for prose answers. */
  contains: (expected, actual) => norm(actual).includes(norm(expected)),

  /** The first number in the answer is within `tolerance` of the expected number. */
  numeric: (expected, actual, tolerance) => {
    const want = Number(expected);
    const got = firstNumber(actual);
    if (got === null || Number.isNaN(want)) return false;
    return Math.abs(got - want) <= Math.max(0, tolerance);
  },

  /** The answer matches the expected pattern (anchored by the author; case-insensitive). */
  regex: (expected, actual) => {
    let re: RegExp;
    try {
      re = new RegExp(expected, "i");
    } catch {
      return false; // a malformed pattern fails closed
    }
    return re.test(actual);
  },

  /**
   * Provenance grader: the answer must cite the expected path token (e.g. `semantic layer`,
   * `fallback`, `stale`). This is how we assert the playbook's "structurally routed + flagged" rule
   * holds — a metric answer that forgot to cite its provenance fails its own eval.
   */
  provenance: (expected, actual) => norm(actual).includes(norm(expected)),
};

/** Grade one case against the produced answer. Pure. */
export function gradeCase(c: EvalCase, actual: string): EvalCaseResult {
  const grader = GRADERS[c.grader];
  if (!grader) {
    return { caseId: c.id, passed: false, actual, detail: `unknown grader: ${String(c.grader)}` };
  }
  const passed = grader(c.expected, actual, c.tolerance ?? 0);
  return {
    caseId: c.id,
    passed,
    actual,
    detail: passed ? "" : `expected (${c.grader}) ${JSON.stringify(c.expected)}, got ${JSON.stringify(actual)}`,
  };
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** The first signed decimal number in a string, or null. */
function firstNumber(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
