/**
 * Per-channel spend governor (issue #591) — the PURE never-exceed decision for a single paid CHANNEL within a
 * single spend PERIOD. Autonomous agents drive paid channels (ads, email tooling, enrichment APIs) and, left
 * unbounded, could run up real money with no ceiling. This core enforces a HARD per-channel, per-period cap:
 * each channel tracks both COMMITTED spend (real money already settled this period) and PROJECTED spend
 * (reservations for in-flight actions not yet settled), and the two are NEVER allowed to cross the cap on the
 * governor's own authority. When a request would cross the cap the governor BLOCKS the spend; the only way
 * forward is an explicit, recorded human approval to raise the cap (see {@link validateRaise} and
 * `spend-governor/service.ts`). There is no "spend over it anyway" path — this is the money gate.
 *
 * Distinct from the global single-cap governor in `budget/` (#670): here the cap is scoped per (workspace,
 * channel) AND resets every period, so a daily ads cap and a monthly email cap are independent ceilings that
 * each refill on their own clock.
 *
 * Premortem (#200) encoded in the SHAPE:
 *  - **§4 irreversible money is pre-committed, never post-hoc.** The cap is the pre-commitment; crossing it is
 *    never autonomous — {@link decideSpend} can only ALLOW-within or BLOCK-and-escalate. Lowering a cap is
 *    always safe and immediate; RAISING it always requires a recorded human approval.
 *  - **§6 injection defense.** Every decision is a pure function of NUMBERS (cap, committed, projected,
 *    request, period key). It never reads provider/agent free text, and the channel id is treated only as an
 *    opaque identity key — so a poisoned read can never flip a gate. Every number is normalized fail-closed:
 *    a non-finite/negative cap blocks everything; a negative counter clamps to 0 (never manufactures
 *    headroom); a non-finite counter clamps UP to the cap (zero remaining); an indeterminate (NaN/±Infinity)
 *    request never auto-spends.
 *
 * No IO, no clock — the counters and the current period key are supplied by the service (which owns the clock
 * + the persisted store) and this module only decides and computes the next counter values.
 */

/** A channel's live spend position against its per-period cap. All money values are cents. */
export interface ChannelSpendState {
  /** The current effective ceiling for this channel/period. Raised ONLY via a recorded human approval; lowered freely. */
  capCents: number;
  /** Real spend already settled against the cap THIS period. */
  committedCents: number;
  /** Reserved/in-flight spend authorized but not yet settled THIS period. */
  projectedCents: number;
  /** The period this state's counters belong to. A change in period (see {@link periodKeyFor}) resets the counters. */
  periodKey: number;
}

/** A channel cap's live status — headroom, utilization, and the two governor flags (alerting / blocked). */
export interface ChannelSpendStatus {
  capCents: number;
  committedCents: number;
  projectedCents: number;
  /** committed + projected (the figure the cap bounds). */
  totalCents: number;
  /** Remaining headroom before the cap (never negative). */
  availableCents: number;
  /** Utilization in basis points (0–10000); a non-positive cap reads as fully utilized (10000). */
  utilizationBps: number;
  /** True once committed+projected reach the cap — further spend is blocked. */
  blocked: boolean;
  /** True once utilization meets/exceeds the alert threshold — the user should be warned. */
  alerting: boolean;
  /** The period these figures describe. */
  periodKey: number;
}

/** The verdict of checking a single spend request against a channel's per-period cap. */
export interface ChannelSpendDecision {
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
 * Normalize a usage counter fail-closed against its (already-normalized) cap: a negative counter clamps to 0
 * (cannot manufacture extra headroom), a non-finite counter clamps UP to the cap (⇒ zero remaining).
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

/**
 * The integer period bucket a wall-clock instant falls in, given a period length. Pure + total: a non-finite
 * or non-positive `periodMs` collapses to a single never-resetting bucket (0); a non-finite `nowMs` clamps to
 * bucket 0. Two instants in the same period yield the same key; the key only advances when the period rolls.
 */
export function periodKeyFor(nowMs: number, periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return 0;
  if (!Number.isFinite(nowMs)) return 0;
  return Math.floor(nowMs / periodMs);
}

/**
 * Roll a channel's state into `currentPeriodKey`: when the state belongs to an earlier (or different) period,
 * its committed + projected counters RESET to 0 and the period key advances — the cap "refills" for the new
 * period. The cap itself carries over (it is the standing ceiling, not per-period usage). When the state is
 * already in the current period it is returned unchanged. Pure + total. Generic so a persisted record's extra
 * fields (e.g. the alert high-water mark) are preserved.
 */
export function rollPeriod<T extends ChannelSpendState>(state: T, currentPeriodKey: number): T {
  const key = Number.isFinite(currentPeriodKey) ? Math.trunc(currentPeriodKey) : 0;
  if (state.periodKey === key) return state;
  return { ...state, committedCents: 0, projectedCents: 0, periodKey: key };
}

/** The live status of a channel's cap. Pure + total. */
export function channelSpendStatus(
  state: ChannelSpendState,
  alertThresholdBps: number = DEFAULT_ALERT_THRESHOLD_BPS,
): ChannelSpendStatus {
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
    blocked: availableCents <= 0,
    alerting: utilizationBps >= threshold,
    periodKey: Number.isFinite(state.periodKey) ? Math.trunc(state.periodKey) : 0,
  };
}

/**
 * Decide whether `requestCents` may be spent against a channel's remaining headroom THIS period. Pure + total:
 *   - a non-positive request is a no-op (allowed, spends nothing);
 *   - an indeterminate request (NaN/±Infinity) never auto-spends → requires approval (#200 §6);
 *   - a request that fits inside the headroom → allowed autonomously;
 *   - a request that would exceed the headroom → BLOCKED, `requiresApproval` (raise the cap), with `overByCents`.
 * The governor never crosses the cap: there is no "allowed AND over the cap" outcome. The caller MUST have
 * already rolled the state into the current period ({@link rollPeriod}) so the decision sees current usage.
 */
export function decideSpend(state: ChannelSpendState, requestCents: number): ChannelSpendDecision {
  const status = channelSpendStatus(state);
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
    return { allowed: true, requiresApproval: false, availableCents, overByCents: 0, reason: "within the channel spend cap" };
  }
  const overByCents = request - availableCents;
  return {
    allowed: false,
    requiresApproval: true,
    availableCents,
    overByCents,
    reason: `spend of ${request}¢ would exceed the channel cap by ${overByCents}¢ — raise the cap (human approval required)`,
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
// preserved by the spread rather than widened away to a bare ChannelSpendState.

/** Reserve `cents` of projected (in-flight) spend. Use only after {@link decideSpend} allowed the request. */
export function applyReserve<T extends ChannelSpendState>(state: T, cents: number): T {
  const add = Number.isFinite(cents) && cents > 0 ? Math.trunc(cents) : 0;
  return { ...state, projectedCents: Math.max(0, normCounter(state.projectedCents, normCap(state.capCents)) + add) };
}

/**
 * Settle a reservation: drop `reservedCents` from projected and add the `actualCents` that were really spent to
 * committed. Counters never go negative.
 */
export function applySettle<T extends ChannelSpendState>(state: T, reservedCents: number, actualCents: number): T {
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
export function applyRelease<T extends ChannelSpendState>(state: T, cents: number): T {
  const drop = Number.isFinite(cents) && cents > 0 ? Math.trunc(cents) : 0;
  return { ...state, projectedCents: Math.max(0, normCounter(state.projectedCents, normCap(state.capCents)) - drop) };
}

/** Lower the cap immediately (always safe — tightening never needs approval). */
export function applyLowerCap<T extends ChannelSpendState>(state: T, toCents: number): T {
  return { ...state, capCents: normCap(toCents) };
}

/** Raise the cap to a new approved ceiling. Call only after a recorded human approval. */
export function applyRaiseCap<T extends ChannelSpendState>(state: T, toCents: number): T {
  return { ...state, capCents: normCap(toCents) };
}
