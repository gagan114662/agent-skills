/**
 * Per-tenant usage accounting (#71). **Pure** cost + window math plus the persistence seams the
 * admission/usage surfaces consume — no DB here, so the math is unit-tested in isolation (the #17
 * pure-decision pattern). The repo-backed {@link UsageStore} lives in `db/repositories/tenant-usage`.
 *
 * Cost is an **estimate**, not a bill: compute-seconds × a configured rate (cents/minute). The rate
 * defaults to 0, so cost is 0 and no budget ever bites unless an operator opts in — preserving #25
 * behavior. Real currency/billing integration is out of scope (see ADR-0040).
 */

/** A tenant's accumulated consumption within one billing window. */
export interface UsageSnapshot {
  /** Sessions launched this window (admitted launches). */
  sessionsStarted: number;
  /** Wall-clock compute-seconds consumed by finalized sessions this window. */
  computeSeconds: number;
  /** Estimated cost (compute-seconds × rate), in cents. */
  estimatedCostCents: number;
}

/** A tenant with no recorded usage this window. */
export const EMPTY_USAGE: UsageSnapshot = {
  sessionsStarted: 0,
  computeSeconds: 0,
  estimatedCostCents: 0,
};

/** The billing window a date falls in: its UTC `YYYY-MM` (a calendar month). */
export function windowKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** Estimated cost in cents for `computeSeconds` at `rateCentsPerMinute`. Non-positive inputs → 0. */
export function estimateCostCents(computeSeconds: number, rateCentsPerMinute: number): number {
  if (rateCentsPerMinute <= 0 || computeSeconds <= 0) return 0;
  return Math.round((computeSeconds / 60) * rateCentsPerMinute);
}

/** Whether accrued cost meets/passes a **positive** budget cap. A 0/undefined cap never bites. */
export function budgetExceeded(estimatedCostCents: number, budgetCents: number): boolean {
  return budgetCents > 0 && estimatedCostCents >= budgetCents;
}

/** Read-only usage seam (the usage dashboard + admission's budget check consume this). */
export interface UsageReader {
  read(workspaceId: string, window: string): Promise<UsageSnapshot>;
}

/**
 * The narrow seam the SessionManager records usage through — it knows only "this tenant launched"
 * and "this tenant burned N compute-seconds", never the window/rate/cost (those live in the prod
 * recorder, which wraps a {@link UsageStore} + the tenant's rate config + a clock). Keeping the
 * manager's surface this small means usage accounting is an optional, swappable concern.
 */
export interface UsageRecorder {
  /** Count one admitted launch (the current window is the recorder's concern). */
  recordStart(workspaceId: string): Promise<void>;
  /** Add a finalized session's compute-seconds (the recorder applies the rate → cost). */
  recordCompute(workspaceId: string, computeSeconds: number): Promise<void>;
}

/** Read + write usage seam (the production {@link UsageRecorder} is built on this). */
export interface UsageStore extends UsageReader {
  /** Count one admitted launch this window (upsert-increment). */
  recordStart(workspaceId: string, window: string): Promise<void>;
  /** Add a finalized session's compute-seconds + estimated cost this window (upsert-increment). */
  recordCompute(
    workspaceId: string,
    window: string,
    computeSeconds: number,
    costCents: number,
  ): Promise<void>;
}
