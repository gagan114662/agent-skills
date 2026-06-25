import type { ReachChannel, ReachEnrollmentStatus, ReachVariant } from "./types.js";

/**
 * Multi-step cadence (#280 step 6). Pure. A cadence is an ordered list of touches, each on a channel,
 * after a wait, in a value-prop angle. Enrolment state advances one step per touch; a reply or an opt-out
 * stops it immediately (we never keep poking someone who answered or asked us to stop).
 */

export interface CadenceStep {
  /** 0-based position in the cadence. */
  stepIndex: number;
  channel: ReachChannel;
  /** Days to wait after the previous step before this one is due (0 for the first touch). */
  waitDays: number;
  /** The value-prop angle this touch leads with. */
  variant: ReachVariant;
}

/**
 * The default 3-touch cadence: an opener, a value follow-up three days later, then a soft LinkedIn nudge.
 * Each touch leads with a different angle so the cadence doesn't repeat itself. Self-tune can swap the
 * lead angle of the FIRST touch (the one most batches start on) without changing the shape.
 */
export const DEFAULT_CADENCE: readonly CadenceStep[] = [
  { stepIndex: 0, channel: "email", waitDays: 0, variant: "pain" },
  { stepIndex: 1, channel: "email", waitDays: 3, variant: "outcome" },
  { stepIndex: 2, channel: "linkedin", waitDays: 4, variant: "social_proof" },
];

export interface CadenceEnrollment {
  contactKey: string;
  /** The NEXT step to take (0 = not yet contacted). */
  currentStep: number;
  /** When the last step fired (ms epoch); 0 before the first touch. */
  lastStepAtMs: number;
  status: ReachEnrollmentStatus;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ENGAGED_FOLLOW_UP_WAIT_DAYS = 1;
const COLD_PAUSE_AFTER_DAYS = 14;

export interface CadenceEngagement {
  opensCount: number;
  lastOpenAtMs: number | null;
  hasReplied: boolean;
}

export interface CadenceDecisionOptions {
  engagement?: CadenceEngagement;
}

/** A fresh enrolment for a net-new prospect (about to take step 0). */
export function newEnrollment(contactKey: string): CadenceEnrollment {
  return { contactKey, currentStep: 0, lastStepAtMs: 0, status: "active" };
}

/**
 * The cadence step that is DUE for an enrolment now, or null when nothing is due: the enrolment is no
 * longer active (replied / opted out / completed), the cadence is exhausted, or the wait hasn't elapsed.
 * The first touch (step 0, wait 0) is always due for an active enrolment.
 */
export function nextDueStep(
  enrollment: CadenceEnrollment,
  cadence: readonly CadenceStep[],
  nowMs: number,
  options: CadenceDecisionOptions = {},
): CadenceStep | null {
  if (enrollment.status !== "active") return null;
  if (options.engagement?.hasReplied) return null;
  if (enrollment.currentStep >= cadence.length) return null;
  const step = cadence[enrollment.currentStep];
  if (!step) return null;
  const engaged = (options.engagement?.opensCount ?? 0) > 0;
  if (
    enrollment.currentStep > 0 &&
    !engaged &&
    nowMs >= enrollment.lastStepAtMs + COLD_PAUSE_AFTER_DAYS * DAY_MS
  ) {
    return null;
  }
  const waitDays =
    engaged && enrollment.currentStep > 0
      ? Math.min(step.waitDays, ENGAGED_FOLLOW_UP_WAIT_DAYS)
      : step.waitDays;
  const dueAt = enrollment.lastStepAtMs + waitDays * DAY_MS;
  if (enrollment.currentStep > 0 && nowMs < dueAt) return null;
  return step;
}

/**
 * Advance an enrolment after a touch fires at `nowMs`: bump the step pointer, stamp the time, and mark it
 * `completed` once the last step is done. Pure — returns a new enrolment.
 */
export function advanceEnrollment(
  enrollment: CadenceEnrollment,
  cadence: readonly CadenceStep[],
  nowMs: number,
): CadenceEnrollment {
  const nextStep = enrollment.currentStep + 1;
  return {
    ...enrollment,
    currentStep: nextStep,
    lastStepAtMs: nowMs,
    status: nextStep >= cadence.length ? "completed" : enrollment.status,
  };
}

/** Stop a cadence because the prospect replied (or opted out). Idempotent. */
export function stopEnrollment(
  enrollment: CadenceEnrollment,
  status: Extract<ReachEnrollmentStatus, "replied" | "opted_out">,
): CadenceEnrollment {
  return { ...enrollment, status };
}
