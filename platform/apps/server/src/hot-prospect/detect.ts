/**
 * Hot-prospect intent detector (issue #622). Pure: `detectIntent` is a deterministic function of its inputs —
 * same activity + policy + `nowMs` in, same {@link IntentDetection} out, every time. No clock, no randomness,
 * no IO (the caller passes the current time so the function stays referentially transparent and testable).
 *
 * The model is intentionally legible (a windowed, weighted, saturating count) rather than opaque, because the
 * acceptance criterion is an EXPLAINABLE alert. Two independent ways to become "hot":
 *
 *   1. A BURST rule fires — e.g. `pricing_view` happened ≥3 times inside the window ("visited pricing 3x
 *      today", the exact pattern #622 names). Any single burst rule is enough on its own.
 *   2. The WEIGHTED SCORE crosses the policy's `scoreThreshold` — a broad pattern of mid-intent signals that
 *      individually wouldn't trip a burst rule still adds up to a hand-raise.
 *
 * Either path sets `isHot`; both are reported so the alert can explain itself.
 */

import type { HotProspectPolicy, IntentRule } from "./caps.js";
import type {
  FiredRule,
  IntentDetection,
  ProspectActivity,
  ProspectSignal,
  ProspectSignalKind,
} from "./types.js";

/** A finite, valid ISO instant parsed to epoch ms, or null when unparseable (the signal is then ignored). */
function parseAt(at: string): number | null {
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

/** Keep only signals whose timestamp is inside `[nowMs - windowMs, nowMs]` — the activity that counts as "recent". */
function windowSignals(signals: readonly ProspectSignal[], nowMs: number, windowMs: number): ProspectSignal[] {
  const floor = nowMs - windowMs;
  const out: ProspectSignal[] = [];
  for (const s of signals) {
    const t = parseAt(s.at);
    // Future-dated events are ignored too (t > nowMs): we never alert on activity that hasn't happened yet.
    if (t === null || t < floor || t > nowMs) continue;
    out.push(s);
  }
  return out;
}

/** Count windowed signals by kind. Kinds with no events are simply absent (treated as "no signal"). */
function countByKind(signals: readonly ProspectSignal[]): Partial<Record<ProspectSignalKind, number>> {
  const counts: Partial<Record<ProspectSignalKind, number>> = {};
  for (const s of signals) {
    counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  }
  return counts;
}

/** The weighted, saturating contribution of one rule given the prospect's count of that kind. */
function ruleScore(rule: IntentRule, count: number): number {
  if (count <= 0) return 0;
  const ratio = Math.min(count / rule.saturateAt, 1);
  return Math.round(rule.weight * ratio);
}

/**
 * Run the detector over one prospect's activity. Windows the signals to the policy's window, scores each rule
 * (saturating), sums to a weighted intent score, and collects every burst rule that fired. `isHot` is true
 * when the score meets `scoreThreshold` OR at least one burst rule fired.
 */
export function detectIntent(
  activity: ProspectActivity,
  policy: HotProspectPolicy,
  nowMs: number,
): IntentDetection {
  const windowed = windowSignals(activity.signals, nowMs, policy.windowMs);
  const counts = countByKind(windowed);

  let score = 0;
  const firedRules: FiredRule[] = [];

  for (const rule of policy.rules) {
    const count = counts[rule.kind] ?? 0;
    if (count <= 0) continue;
    score += ruleScore(rule, count);
    if (rule.burstThreshold > 0 && count >= rule.burstThreshold) {
      firedRules.push({ kind: rule.kind, label: rule.label, count, threshold: rule.burstThreshold });
    }
  }

  // Strongest burst first (highest count), so the headline names the loudest signal.
  firedRules.sort((a, b) => b.count - a.count || b.threshold - a.threshold);

  const isHot = firedRules.length > 0 || score >= policy.scoreThreshold;

  return {
    prospectId: activity.prospectId,
    score,
    isHot,
    firedRules,
    counts,
    reason: reasonFor(score, firedRules, policy.scoreThreshold),
  };
}

/** Build the one-line headline reason: lead with the strongest burst rule, else the threshold-crossing score. */
function reasonFor(score: number, firedRules: readonly FiredRule[], scoreThreshold: number): string {
  const top = firedRules[0];
  if (top) {
    return `${top.label} ${top.count}× in the window (threshold ${top.threshold})`;
  }
  return `Intent score ${score} crossed the threshold of ${scoreThreshold}`;
}
