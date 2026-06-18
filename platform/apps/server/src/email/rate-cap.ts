/**
 * Email send rate caps (issue #268, ADR-0268, premortem #200 §4). Domain warmup ({@link warmupAllows} in
 * acquisition/compliance.ts) bounds the *per-day* volume of a fresh sender; this adds an orthogonal
 * *rolling-window* cap so a burst inside any short window (per-minute / per-hour) can't blow past the
 * provider's rate limit or torch reputation. Bursting from a cold or shared IP is part of the irreversible
 * blast radius the premortem warns about, so the cap is enforced in code, not left to agent good intentions.
 *
 * Pure: a function of (prior send timestamps, window, cap, requested, now). `now`/timestamps are injected,
 * so it is unit-tested without a clock.
 */

export interface RateCapInput {
  /** Epoch-ms timestamps of prior sends (any age — the window filter drops the old ones). */
  sentAtMs: number[];
  /** The trailing window width in ms (e.g. 60_000 for a per-minute cap). */
  windowMs: number;
  /** Max sends permitted inside the trailing window. */
  capPerWindow: number;
  /** How many sends are being requested now. */
  requested: number;
  /** Current time (epoch ms), injected so the decision is deterministic. */
  now: number;
}

export interface RateCapDecision {
  allowed: boolean;
  capPerWindow: number;
  /** Sends already inside the trailing window. */
  inWindow: number;
  /** How many of `requested` fit under the remaining headroom. */
  grantable: number;
  reason: string;
}

/**
 * Decide how much of a requested batch fits under a rolling-window cap. Counts the prior sends still inside
 * the trailing `[now - windowMs, now]` window, grants up to the remaining headroom, and never grants more
 * than `requested`. A non-positive cap grants nothing. Total + pure.
 */
export function rateCapAllows(input: RateCapInput): RateCapDecision {
  const { windowMs, capPerWindow, requested, now } = input;
  const cutoff = now - windowMs;
  const inWindow = input.sentAtMs.filter((t) => t >= cutoff && t <= now).length;
  if (capPerWindow <= 0) {
    return { allowed: false, capPerWindow, inWindow, grantable: 0, reason: "rate cap is zero — no sends permitted" };
  }
  const headroom = Math.max(0, capPerWindow - inWindow);
  const grantable = Math.max(0, Math.min(requested, headroom));
  return {
    allowed: grantable > 0,
    capPerWindow,
    inWindow,
    grantable,
    reason:
      grantable >= requested
        ? `within rate cap (${inWindow}+${requested}/${capPerWindow} per window)`
        : `rate cap: ${headroom} of ${requested} grantable (${inWindow}/${capPerWindow} sent in window)`,
  };
}

/** The shape both {@link rateCapAllows} and `warmupAllows` (acquisition/compliance.ts) return for `combineSendCaps`. */
export interface GrantableCap {
  grantable: number;
  reason: string;
}

export interface SendBudgetDecision {
  allowed: boolean;
  grantable: number;
  reason: string;
}

/**
 * Combine N independent caps (warmup + rate, and any future cap) into a single send budget: the grantable is
 * the most-restrictive (minimum) across all caps, never exceeding `requested`, and the reason is the binding
 * cap's reason. Blocked when any cap grants zero. This is how the live-send pipeline composes the existing
 * per-day warmup with the rolling-window rate cap. Total + pure.
 */
export function combineSendCaps(requested: number, ...caps: GrantableCap[]): SendBudgetDecision {
  let grantable = Math.max(0, requested);
  let reason = "within all send caps";
  for (const cap of caps) {
    const g = Math.max(0, cap.grantable);
    if (g < grantable) {
      grantable = g;
      reason = cap.reason;
    }
  }
  return { allowed: grantable > 0, grantable, reason };
}
