import type { FlywheelCaps } from "./caps.js";
import { aboveThreshold, hasNewOccurrences } from "./guards.js";
import type { DispatchDecision, FingerprintRecord, IssueDecision } from "./types.js";

/**
 * The flywheel decisions (#117, ADR-0117 §4/§5). **Pure + unit-tested**: the engine does the side
 * effects (file the issue, launch the fix, enqueue the approval, write the row); these functions make
 * the single choice — the #105 `decideRevival` / #96 `decideVenture` split.
 */

/**
 * What to do about a fingerprint's GitHub issue this tick. Priority is deliberate — the dedup contract
 * (ONE open issue per fingerprint) is enforced here, from our own state, not GitHub's:
 *   1. recurred-after-fix with an issue   → reopen   (the #106 outcome verifier escalates it back)
 *   2. no issue yet + over threshold      → draft    (rate-limited by the engine)
 *   3. open issue + new occurrences       → comment  (never a duplicate issue)
 *   4. otherwise                          → noop
 */
export function decideIssueAction(fp: FingerprintRecord, caps: FlywheelCaps): IssueDecision {
  if (fp.status === "recurred" && fp.issueRef) {
    return { action: "reopen", reason: "recurrence_after_fix" };
  }
  if (!fp.issueRef) {
    if (aboveThreshold(fp.occurrenceCount, caps.issueThreshold)) {
      return { action: "draft", reason: "above_threshold" };
    }
    return { action: "noop", reason: "below_threshold" };
  }
  if (fp.issueState === "open" && hasNewOccurrences(fp.occurrenceCount, fp.syncedOccurrenceCount)) {
    return { action: "comment", reason: "recurrence" };
  }
  return { action: "noop", reason: "synced" };
}

export interface DispatchDecisionInput {
  /** Recurrence-after-fix (#106) — a "fixed" failure that came back. Human review required. */
  excludedFromAutoDispatch: boolean;
  /** Whether a #95 policy rule auto-approves this fingerprint's class (sensitive-by-default). */
  autoAllowed: boolean;
  /** The workspace has met/passed its #71 tenant-usage dollar ceiling — stop spending. */
  budgetExhausted: boolean;
  /** Whether there is headroom under the hard concurrent-fix cap. */
  concurrencyAvailable: boolean;
}

/**
 * Whether to auto-dispatch a fix, queue it for a human, or skip this tick. The **route** is decided
 * first — queueing for a human consumes no session slot and no spend, so it always proceeds; the spend
 * + blast-radius caps bound only the auto-launch path:
 *   1. excluded (recurred-after-fix) → queue  (a fix already failed once — a human decides)
 *   2. class not #95-auto-allowed    → queue  (sensitive-by-default)
 *   — auto path only, in order: —
 *   3. budget exhausted              → skip   (no more spend on auto fixes)
 *   4. no concurrency headroom       → skip   (hard cap on in-flight fix sessions)
 *   5. otherwise                     → auto
 */
export function decideDispatch(input: DispatchDecisionInput): DispatchDecision {
  if (input.excludedFromAutoDispatch) return { action: "queue", reason: "recurred_after_fix" };
  if (!input.autoAllowed) return { action: "queue", reason: "policy_requires_approval" };
  if (input.budgetExhausted) return { action: "skip", reason: "budget_exhausted" };
  if (!input.concurrencyAvailable) return { action: "skip", reason: "concurrency_cap" };
  return { action: "auto", reason: "auto_dispatch" };
}
