/**
 * Pure threshold predicates for Outcome Verifiers (#106), mirroring `sre/guards.ts` /
 * `flywheel/guards.ts`. No IO — the registry composes these and tests pin each boundary.
 */

/** True when an HTTP status is in the 2xx success range. */
export function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** True when a measured value is at or above its target (the ≥ gate growth/revenue use). */
export function meetsAtLeast(value: number, target: number): boolean {
  return value >= target;
}

/** True when a fixed failure has not recurred (the `fix_held` gate). */
export function noRecurrence(recurrenceCount: number): boolean {
  return recurrenceCount <= 0;
}
