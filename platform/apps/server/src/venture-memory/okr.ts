import type { KeyResult, OkrRecord } from "./types.js";

/**
 * OKR progress + drift (#197, ADR-0197). **Pure** — no DB. 2–3 measurable objectives per venture; every
 * session brief and the weekly report carry the OKRs + their drift flags. The premortem discipline is
 * baked into the type: an **unverified** key result (no externally-verified #106 source) can NEVER read
 * `on_track` — it reads `unverified` and flags the OKR as drifting, exactly as the #96 scorecard
 * distinguishes `Evidence{source}` from an assumption. A self-reported number is never "on track".
 */

/**
 * The state of one key result:
 *   - `achieved`   — verified AND progress ≥ 1.
 *   - `on_track`   — verified AND progress ≥ the pace target (where it should be by now).
 *   - `behind`     — verified BUT progress below the pace target.
 *   - `unverified` — no #106 source, regardless of the number (premortem #200, mode 2).
 */
export type KeyResultStatus = "achieved" | "on_track" | "behind" | "unverified";

export interface KeyResultDrift {
  metric: string;
  target: number;
  current: number;
  unit: string;
  verified: boolean;
  source: string | null;
  /** `current / target`, clamped to [0, 1]. 0 when the target is ≤ 0 (an ill-formed KR). */
  progress: number;
  status: KeyResultStatus;
}

export interface OkrDrift {
  okrId: string;
  ideaId: string;
  objective: string;
  keyResults: KeyResultDrift[];
  /** True when ANY key result is `behind` or `unverified` — the brief's drift flag. */
  drifting: boolean;
  verifiedCount: number;
  totalCount: number;
}

/** Clamp `current / target` to [0, 1]; an ill-formed (≤ 0) target reads as 0 progress. */
export function keyResultProgress(kr: Pick<KeyResult, "current" | "target">): number {
  if (kr.target <= 0) return 0;
  return Math.max(0, Math.min(1, kr.current / kr.target));
}

/**
 * The drift of one key result against a pace target (0..1 — where it should be by now; default 1 = the
 * KR should be at target by the period's end). Verification gates everything: no `verified` source ⇒
 * `unverified`, no matter how good the number looks.
 */
export function computeKeyResultDrift(kr: KeyResult, paceTarget = 1): KeyResultDrift {
  const progress = keyResultProgress(kr);
  let status: KeyResultStatus;
  if (!kr.verified) {
    status = "unverified";
  } else if (progress >= 1) {
    status = "achieved";
  } else if (progress >= Math.max(0, Math.min(1, paceTarget))) {
    status = "on_track";
  } else {
    status = "behind";
  }
  return {
    metric: kr.metric,
    target: kr.target,
    current: kr.current,
    unit: kr.unit,
    verified: kr.verified,
    source: kr.source,
    progress,
    status,
  };
}

/** The drift of an OKR: each key result's drift + the rolled-up `drifting` flag. */
export function computeOkrDrift(okr: OkrRecord, paceTarget = 1): OkrDrift {
  const keyResults = okr.keyResults.map((kr) => computeKeyResultDrift(kr, paceTarget));
  return {
    okrId: okr.id,
    ideaId: okr.ideaId,
    objective: okr.objective,
    keyResults,
    drifting: keyResults.some((k) => k.status === "behind" || k.status === "unverified"),
    verifiedCount: keyResults.filter((k) => k.verified).length,
    totalCount: keyResults.length,
  };
}

/**
 * Validate a venture's OKR count against the 2–3 guidance (AC4). Returns `ok` plus a human message so
 * the recording surface can warn an owner who declares one objective or seven.
 */
export function validateOkrCount(okrs: { length: number }): {
  ok: boolean;
  count: number;
  message: string;
} {
  const count = okrs.length;
  if (count < 2) return { ok: false, count, message: "a venture needs at least 2 objectives" };
  if (count > 3) return { ok: false, count, message: "a venture should carry at most 3 objectives" };
  return { ok: true, count, message: "ok" };
}
