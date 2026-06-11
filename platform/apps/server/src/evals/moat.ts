/**
 * The eval → moat tie-in (#155, ADR-0155 §6). **Pure**. A held/improved eval suite is evidence the fleet's
 * skills compound — exactly the `accumulatedEvals` moat dimension (`moat/score.ts`). This maps a suite
 * summary to a moat accrual magnitude so maintained skills literally widen the moat. The magnitude scales
 * with both breadth (how many cases) and quality (the pass rate): a 100%-passing 17-case suite accrues more
 * than a 60%-passing 5-case one. Kept tiny + pure so the loop is unit-tested without the moat repo.
 */

import type { EvalRunSummary } from "./types.js";

/**
 * Accrual magnitude for one eval run: `passed × passRate`. A run with no passing cases accrues nothing
 * (an empty/failing suite is not a moat). The moat subscore is saturating (`10m/(m+k)`), so this only needs
 * to be a monotonic, sane signal — sustained passing breadth, not one big dump, builds the moat.
 */
export function evalAccrualMagnitude(summary: EvalRunSummary): number {
  if (summary.passed <= 0) return 0;
  return summary.passed * summary.passRate;
}
