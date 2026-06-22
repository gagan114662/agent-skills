/**
 * Global spend-cap governor (issue #670) — the PURE never-exceed decision. A workspace's spend cap is a
 * single hard ceiling across ALL of its API + paid actions: the system tracks both COMMITTED spend (real
 * money already settled) and PROJECTED spend (reservations for in-flight actions not yet settled), and it
 * NEVER lets the two cross the cap on its own. When a request would cross the cap the governor HALTS the
 * spend and the only way forward is an explicit human approval to RAISE the cap (see {@link validateRaise}
 * and `budget/service.ts`). There is no "spend over it anyway" path.
 *
 * Premortem (#200) encoded in the SHAPE — mirrors the per-customer `enterprise/budget.ts` cap:
 *  - **§4 irreversible money is pre-committed, never post-hoc.** The cap is the pre-commitment; crossing it
 *    is never autonomous — `decideSpend` can only ALLOW-within or HALT-and-escalate. Lowering a cap is
 *    always safe and immediate; RAISING it always requires a recorded human approval.
 *  - **§6 injection defense.** Every decision is a pure function of NUMBERS (cap, committed, projected,
 *    request) — it never reads provider/agent free text, so a poisoned read can never flip a gate. Every
 *    number is normalized fail-closed: a non-finite/negative cap blocks everything; a negative counter
 *    clamps to 0 (never manufactures headroom); a non-finite counter clamps UP to the cap (zero remaining);
 *    an indeterminate (NaN/±Infinity) request never auto-spends.
 *
 * No IO, no clock — the counters are loaded by the service and the persisted store is the source of truth
 * for "what has been committed/reserved". This module only decides and computes the next counter values.
 */

/** A workspace's live spend position against its global cap. All values are cents. */
export interface SpendState {
  /** The current effective ceiling. Raised ONLY via a recorded human approval; lowered freely. */
  capCents: number;
  /** Real spend already settled against the cap. */
  committedCents: number;
  /** Reserved/in-flight spend authorized but not yet settled. */
  projectedCents: number;
}

/** A cap's live status — headroom, utilization, and the two governor flags (alerting / halted). */
export interface SpendStatus {
  capCents: number;
  committedCents: number;
  projectedCents: number;
  /** committed + projected (the figure the cap bounds). */
  totalCents: number;
  /** Remaining headroom before the cap (never negative). */
  availableCents: number;
  /** Utilization in basis points (0–10000); a non-positive cap reads as fully utilized (10000). */
  utilizationBps: number;
  /** True once committed+projected reach the cap — further spend is halted. */
  halted: boolean;
  /** True once utilization meets/exceeds the alert threshold — the user should be warned. */
  alerting: boolean;
}

/** The verdict of checking a single spend request against the cap. */
export interface SpendDecision {
  /** May the spend proceed now (it fits inside the remaining headroom)? */
  allowed: boolean;
  /** Does proceeding require raising the cap, which needs a recorded human approval? */
  requiresApproval: boolean;
  /** Headroom available before this request. */
  availableCents: number;
  /** How many cents the request exceeds the headroom by (0 when allowed). */
  overByCents: number;
  reason: string;
}

/** Default alert threshold (80% of the cap) when none is configured. */
export const DEFAULT_ALERT_THRESHOLD_BPS = 8_000;

/** Normalize a cap ceiling fail-closed: a non-finite / negative cap becomes 0 (⇒ blocks everything). */
function normCap(capCents: number): number {
  return Number.isFinite(capCents) && capCents > 0 ? Math.trunc(capCents) : 0;
}

/**
 * Normalize a usage counter fail-closed against its (already-normalized) cap: a negative counter clamps to
 * 0 (cannot manufacture extra headroom), a non-finite counter clamps UP to the cap (⇒ zero remaining).
 */
function normCounter(value: number, capNorm: number): number {
  if (!Number.isFinite(value)) return capNorm;
  return value > 0 ? Math.trunc(value) : 0;
}

/** Clamp an alert threshold into the valid basis-point range, defaulting a bad value to 80%. */
function normThresholdBps(bps: number): number {
  if (!Number.isFinite(bps)) return DEFAULT_ALERT_THRESHOLD_BPS;
  return Math.min(10_000, Math.max(0, Math.trunc(bps)));
}

/** The live status of a workspace's cap. Pure + total. */
export function spendStatus(state: SpendState, alertThresholdBps: number = DEFAULT_ALERT_THRESHOLD_BPS): SpendStatus {
  const capCents = normCap(state.capCents);
  const committedCents = normCounter(state.committedCents, capCents);
  const projectedCents = normCounter(state.projectedCents, capCents);
  const totalCents = committedCents + projectedCents;
  const availableCents = Math.max(0, capCents - totalCents);
  const utilizationBps = capCents > 0 ? Math.min(10_000, Math.round((totalCents / capCents) * 10_000)) : 10_000;
  const threshold = normThresholdBps(alertThresholdBps);
  return {
    capCents,
    committedCents,
    projectedCents,
    totalCents,
    availableCents,
    utilizationBps,
    halted: availableCents <= 0,
    alerting: utilizationBps >= threshold,
  };
}

/**
 * Decide whether `requestCents` may be spent against the workspace's remaining headroom. Pure + total:
 *   - a non-positive request is a no-op (allowed, spends nothing);
 *   - an indeterminate request (NaN/±Infinity) never auto-spends → requires approval (#200 §6);
 *   - a request that fits inside the headroom → allowed autonomously;
 *   - a request that would exceed the headroom → HALTED, `requiresApproval` (raise the cap), with `overByCents`.
 * The system never crosses the cap: there is no "allowed AND over the cap" outcome.
 */
export function decideSpend(state: SpendState, requestCents: number): SpendDecision {
  const status = spendStatus(state);
  const availableCents = status.availableCents;

  if (!Number.isFinite(requestCents)) {
    return {
      allowed: false,
      requiresApproval: true,
      availableCents,
      overByCents: 0,
      reason: "indeterminate spend amount — human approval required (never auto-spend on uncertainty)",
    };
  }
  const request = Math.trunc(requestCents);
  if (request <= 0) {
    return { allowed: true, requiresApproval: false, availableCents, overByCents: 0, reason: "no spend requested" };
  }
  if (request <= availableCents) {
    return { allowed: true, requiresApproval: false, availableCents, overByCents: 0, reason: "within the spend cap" };
  }
  const overByCents = request - availableCents;
  return {
    allowed: false,
    requiresApproval: true,
    availableCents,
    overByCents,
    reason: `spend of ${request}¢ would exceed the cap by ${overByCents}¢ — raise the cap (human approval required)`,
  };
}

/** The verdict of validating a proposed cap raise. */
export interface RaiseValidation {
  ok: boolean;
  reason: string;
}

/**
 * Validate a proposed new cap as a RAISE: it must be a finite, non-negative amount STRICTLY greater than the
 * current cap. A target at or below the current cap is not a raise (lower it directly, no approval needed).
 */
export function validateRaise(currentCapCents: number, toCents: number): RaiseValidation {
  const current = normCap(currentCapCents);
  if (!Number.isFinite(toCents) || toCents < 0) {
    return { ok: false, reason: "the new cap must be a finite, non-negative amount" };
  }
  const target = Math.trunc(toCents);
  if (target <= current) {
    return { ok: false, reason: "the new cap must be greater than the current cap (lower it directly instead)" };
  }
  return { ok: true, reason: "valid cap raise" };
}

// ---- pure state transitions (the service persists the returned state) -------------------------
// Generic in the state type so a persisted record's extra fields (e.g. the alert high-water mark) are
// preserved by the spread rather than widened away to a bare SpendState.

/** Reserve `cents` of projected (in-flight) spend. Use only after {@link decideSpend} allowed the request. */
export function applyReserve<T extends SpendState>(state: T, cents: number): T {
  const add = Number.isFinite(cents) && cents > 0 ? Math.trunc(cents) : 0;
  return { ...state, projectedCents: Math.max(0, normCounter(state.projectedCents, normCap(state.capCents)) + add) };
}

/**
 * Settle a reservation: drop `reservedCents` from projected and add the `actualCents` that were really spent
 * to committed. Counters never go negative.
 */
export function applySettle<T extends SpendState>(state: T, reservedCents: number, actualCents: number): T {
  const cap = normCap(state.capCents);
  const reserved = Number.isFinite(reservedCents) && reservedCents > 0 ? Math.trunc(reservedCents) : 0;
  const actual = Number.isFinite(actualCents) && actualCents > 0 ? Math.trunc(actualCents) : 0;
  return {
    ...state,
    committedCents: normCounter(state.committedCents, cap) + actual,
    projectedCents: Math.max(0, normCounter(state.projectedCents, cap) - reserved),
  };
}

/** Release a reservation that will not be spent (the action was cancelled). Projected never goes negative. */
export function applyRelease<T extends SpendState>(state: T, cents: number): T {
  const drop = Number.isFinite(cents) && cents > 0 ? Math.trunc(cents) : 0;
  return { ...state, projectedCents: Math.max(0, normCounter(state.projectedCents, normCap(state.capCents)) - drop) };
}

/** Lower the cap immediately (always safe — tightening never needs approval). */
export function applyLowerCap<T extends SpendState>(state: T, toCents: number): T {
  return { ...state, capCents: normCap(toCents) };
}

/** Raise the cap to a new approved ceiling. Call only after a recorded human approval. */
export function applyRaiseCap<T extends SpendState>(state: T, toCents: number): T {
  return { ...state, capCents: normCap(toCents) };
}
