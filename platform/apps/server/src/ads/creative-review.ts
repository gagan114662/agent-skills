/**
 * Graceful platform creative review — pure decision core (#272, ADR-0272). After Bid submits an ad creative,
 * the ad platform (Google/Meta) reviews it and can APPROVE, REJECT (disapprove), serve it with LIMITS, or sit
 * IN REVIEW for hours/days. The issue's hard requirement: Bid must handle rejection AND delay GRACEFULLY and
 * surface HONEST status — never fabricate "approved", never spend behind an un-approved creative.
 *
 * Two premortem invariants are encoded here:
 *   - #200 §3 (production-grounded / honest): the user-facing status is derived ONLY from the platform's real
 *     review state read back from the API. An unrecognized/empty state fails CLOSED to `unknown` (cannot
 *     serve, blocks spend) — never an optimistic "approved".
 *   - #200 §6 (injection defense): the platform's free-text rejection `reason` is EXTERNALLY-SOURCED and
 *     untrusted. It is run through {@link sanitizeProviderText} (control chars stripped, whitespace collapsed,
 *     truncated) before it can ever be surfaced — a poisoned reason can reach a human but never steer logic.
 *
 * Pure ⇒ unit-testable; no IO. The provider read lives in `provider.ts`, the surfacing in `service.ts`.
 */
import { sanitizeProviderText } from "../provisioning/quarantine.js";

/** The normalized, user-facing review status. Honest + fail-closed. */
export type CreativeReviewStatus = "approved" | "rejected" | "pending_review" | "limited" | "unknown";

/** How long a pending review can sit before we honestly flag it as taking longer than usual. */
export const REVIEW_DELAY_THRESHOLD_HOURS = 48;

export interface CreativeReviewInput {
  /** Structural reference to the creative under review (data — never parsed for directives). */
  creativeRef: string;
  /** The RAW platform review state, read back from the ad API (untrusted free text). */
  state: string;
  /** The platform's rejection/limitation reason, if any (externally-sourced, sanitized before surfacing). */
  reason?: string | null;
  /** How long the creative has been in review (hours), if known — used to flag a delayed review honestly. */
  ageHours?: number;
}

export interface CreativeReviewDecision {
  creativeRef: string;
  status: CreativeReviewStatus;
  /** May the creative actually serve impressions right now? (false unless explicitly approved/limited). */
  canServe: boolean;
  /** Must we refuse to release spend behind this creative? (true unless it is cleared to serve). */
  blocksSpend: boolean;
  /** A pending review that has sat longer than {@link REVIEW_DELAY_THRESHOLD_HOURS}. */
  delayed: boolean;
  /** An honest, human-readable status line (carries the sanitized platform reason when present). */
  message: string;
}

/** Raw platform states that mean APPROVED. */
const APPROVED_STATES = new Set(["approved", "active", "eligible", "serving", "enabled", "ok"]);
/** Raw platform states that mean REJECTED / disapproved. */
const REJECTED_STATES = new Set(["rejected", "disapproved", "denied", "removed", "policy_violation"]);
/** Raw platform states that mean PENDING / under review. */
const PENDING_STATES = new Set([
  "pending",
  "pending_review",
  "in_review",
  "under_review",
  "submitted",
  "processing",
  "reviewing",
]);
/** Raw platform states that mean ELIGIBLE WITH LIMITS (serves, but restricted). */
const LIMITED_STATES = new Set([
  "limited",
  "eligible_limited",
  "approved_limited",
  "serving_limited",
  "demand_restricted",
]);

function normalize(state: string): CreativeReviewStatus {
  const s = state.trim().toLowerCase();
  if (APPROVED_STATES.has(s)) return "approved";
  if (REJECTED_STATES.has(s)) return "rejected";
  if (LIMITED_STATES.has(s)) return "limited";
  if (PENDING_STATES.has(s)) return "pending_review";
  return "unknown";
}

/**
 * Decide the honest status of a single creative review. Total + pure. Only `approved` and `limited` are
 * cleared to serve; everything else (rejected, pending, unknown) cannot serve and blocks spend — so the fleet
 * never spends behind a creative the platform has not cleared.
 */
export function decideCreativeReview(input: CreativeReviewInput): CreativeReviewDecision {
  const status = normalize(input.state);
  const reason = sanitizeProviderText(input.reason);
  const ageHours = Number.isFinite(input.ageHours) ? (input.ageHours as number) : 0;
  const delayed = status === "pending_review" && ageHours >= REVIEW_DELAY_THRESHOLD_HOURS;

  let canServe = false;
  let blocksSpend = true;
  let message: string;
  switch (status) {
    case "approved":
      canServe = true;
      blocksSpend = false;
      message = "Approved by the ad platform — cleared to serve.";
      break;
    case "limited":
      canServe = true;
      blocksSpend = false;
      message = reason
        ? `Approved with limits by the ad platform: ${reason}`
        : "Approved with limits by the ad platform — serving is restricted.";
      break;
    case "rejected":
      message = reason
        ? `Rejected by the ad platform: ${reason} — fix the creative and resubmit.`
        : "Rejected by the ad platform — fix the creative and resubmit.";
      break;
    case "pending_review":
      message = delayed
        ? "In review by the ad platform — this is taking longer than usual; spend stays paused until it clears."
        : "In review by the ad platform — spend stays paused until it clears.";
      break;
    default:
      message = "Review status is unknown — treating as not cleared; spend stays paused.";
      break;
  }
  return { creativeRef: input.creativeRef, status, canServe, blocksSpend, delayed, message };
}

export interface CreativeReviewSummary {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  limited: number;
  unknown: number;
  /** True iff there is at least one creative and EVERY one is cleared to serve (approved or limited). */
  allClear: boolean;
  /** An honest one-line headline for the founder console / brief. */
  headline: string;
}

/** Aggregate a set of review decisions into an honest summary (never optimistic). Total + pure. */
export function summarizeCreativeReviews(reviews: CreativeReviewDecision[]): CreativeReviewSummary {
  const count = (s: CreativeReviewStatus) => reviews.filter((r) => r.status === s).length;
  const approved = count("approved");
  const rejected = count("rejected");
  const pending = count("pending_review");
  const limited = count("limited");
  const unknown = count("unknown");
  const total = reviews.length;
  const allClear = total > 0 && rejected === 0 && pending === 0 && unknown === 0;

  let headline: string;
  if (total === 0) headline = "No creatives in review.";
  else if (rejected > 0) headline = `${rejected} creative${rejected === 1 ? "" : "s"} rejected — needs attention.`;
  else if (pending > 0 || unknown > 0)
    headline = `${pending + unknown} creative${pending + unknown === 1 ? "" : "s"} awaiting platform review.`;
  else headline = `All ${total} creative${total === 1 ? "" : "s"} cleared to serve.`;

  return { total, approved, rejected, pending, limited, unknown, allClear, headline };
}
