/**
 * The anti-spam / relevance gate for the community participation agent (issue #597). This is the legible heart of
 * the value-first guarantee: a pure, FAIL-CLOSED function that decides whether a drafted reply may even be
 * queued for approval. Same inputs in, same {@link GateDecision} out — no clock (the instant is passed in), no
 * randomness, no IO.
 *
 * Fail-closed means: the gate collects EVERY violated rule and blocks if there is even one. A reply is allowed
 * only when it clears all of relevance, freshness, substance, disclosure, self-promotion ratio, rate limit, and
 * cooldown. Adding a rule can only ever make the gate stricter.
 *
 * #200 §6 trust boundary: the gate reads ONLY structural signals — the precomputed relevance, the thread's age,
 * the draft's own flags and word count, and the participation history counts. It never parses the untrusted
 * thread title/body prose, so a poisoned thread cannot talk its way past the guardrails.
 */

import type { AntiSpamPolicy } from "./caps.js";
import type { CommunityThread, ParticipationDraft } from "./types.js";

/** One past reply in the same community — the structural history the gate weighs for ratios and rate limits. */
export interface ParticipationHistoryItem {
  /** When the past reply was posted. */
  postedAt: Date;
  /** Did that past reply mention the product? (drives the self-promotion ratio). */
  mentionedProduct: boolean;
}

/** Everything the gate needs to decide one reply. */
export interface GateInput {
  thread: CommunityThread;
  draft: ParticipationDraft;
  /** Recent participation history in the SAME community, in any order. */
  history: ParticipationHistoryItem[];
  policy: AntiSpamPolicy;
  /** The evaluation instant — passed in so the gate stays pure (rate-limit / cooldown math). */
  now: Date;
}

/** The machine-readable reason a reply was blocked (or `ok` when allowed). */
export type GateCode =
  | "ok"
  | "not_relevant"
  | "thread_too_old"
  | "reply_too_short"
  | "undisclosed_affiliation"
  | "promo_ratio_exceeded"
  | "rate_limited"
  | "cooldown_active";

export interface GateReason {
  code: GateCode;
  message: string;
}

export interface GateDecision {
  decision: "allow" | "block";
  /** All violated rules. Empty iff allowed. Fail-closed: any entry ⇒ `block`. */
  reasons: GateReason[];
  /** The relevance the gate saw (0..1). */
  relevance: number;
  /** The self-promotion ratio this reply WOULD produce if posted (0..1) — surfaced for the reviewer. */
  promoRatioAfter: number;
  /** How many replies already fall inside the rate window. */
  repliesInWindow: number;
}

const HOUR_MS = 3_600_000;

/** Count whitespace-delimited words in a body. Pure; used for the "substance" floor. */
function wordCount(body: string): number {
  return body.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

/** The N most-recent history items (newest first), the window the ratio/rate rules weigh. */
function recentHistory(
  history: readonly ParticipationHistoryItem[],
  window: number,
): ParticipationHistoryItem[] {
  return [...history]
    .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())
    .slice(0, Math.max(0, window));
}

/**
 * Evaluate one drafted reply against the anti-spam / relevance policy. Returns a structural decision plus the
 * full list of violated rules (fail-closed: any violation ⇒ `block`). Never throws on ordinary input.
 */
export function evaluateGate(input: GateInput): GateDecision {
  const { thread, draft, policy, now } = input;
  const reasons: GateReason[] = [];

  // 1. Relevance floor — don't reply to threads we have nothing useful to say about.
  if (draft.relevance < policy.minRelevance) {
    reasons.push({
      code: "not_relevant",
      message: `relevance ${draft.relevance.toFixed(2)} is below the ${policy.minRelevance.toFixed(2)} floor`,
    });
  }

  // 2. Freshness — never necro a long-dead thread (reads as drive-by spam).
  if (thread.ageHours > policy.maxThreadAgeHours) {
    reasons.push({
      code: "thread_too_old",
      message: `thread is ${Math.round(thread.ageHours)}h old (max ${policy.maxThreadAgeHours}h)`,
    });
  }

  // 3. Substance — a value-first reply must actually say something.
  const words = wordCount(draft.body);
  if (words < policy.minReplyWords) {
    reasons.push({
      code: "reply_too_short",
      message: `reply has ${words} words (min ${policy.minReplyWords})`,
    });
  }

  // 4. Disclosure — any product mention MUST disclose affiliation (the issue's hard requirement). Fail-closed.
  if (draft.mentionsProduct && !draft.hasDisclosure) {
    reasons.push({
      code: "undisclosed_affiliation",
      message: "reply mentions the product without an affiliation disclosure",
    });
  }

  // 5. Self-promotion ratio — keep promotional replies a small minority of our participation in a community.
  const recent = recentHistory(input.history, policy.historyWindow);
  const recentPromo = recent.filter((h) => h.mentionedProduct).length;
  const totalAfter = recent.length + 1;
  const promoAfter = (recentPromo + (draft.mentionsProduct ? 1 : 0)) / totalAfter;
  // Only a product-mentioning reply can violate the promo ratio; a purely-helpful reply never does.
  if (draft.mentionsProduct && promoAfter > policy.maxPromoRatio) {
    reasons.push({
      code: "promo_ratio_exceeded",
      message: `would make ${(promoAfter * 100).toFixed(0)}% of recent replies promotional (max ${(policy.maxPromoRatio * 100).toFixed(0)}%)`,
    });
  }

  // 6. Rate limit — cap how many replies land in a community per rolling window.
  const windowStart = now.getTime() - policy.rateWindowHours * HOUR_MS;
  const repliesInWindow = input.history.filter((h) => h.postedAt.getTime() >= windowStart).length;
  if (repliesInWindow >= policy.maxRepliesPerWindow) {
    reasons.push({
      code: "rate_limited",
      message: `${repliesInWindow} replies already in the last ${policy.rateWindowHours}h (max ${policy.maxRepliesPerWindow})`,
    });
  }

  // 7. Cooldown — enforce minimum spacing since the most recent reply in the community.
  if (input.history.length > 0) {
    const lastPostedAt = Math.max(...input.history.map((h) => h.postedAt.getTime()));
    const hoursSince = (now.getTime() - lastPostedAt) / HOUR_MS;
    if (hoursSince < policy.minHoursBetweenReplies) {
      reasons.push({
        code: "cooldown_active",
        message: `only ${hoursSince.toFixed(1)}h since the last reply (min ${policy.minHoursBetweenReplies}h)`,
      });
    }
  }

  return {
    decision: reasons.length === 0 ? "allow" : "block",
    reasons,
    relevance: draft.relevance,
    promoRatioAfter: promoAfter,
    repliesInWindow,
  };
}

/** Convenience: did the gate allow the reply? */
export function isAllowed(decision: GateDecision): boolean {
  return decision.decision === "allow";
}

/** Re-derive history items from terminal participation records of the same community (for the service). */
export function historyFromPosts(
  posts: readonly { mentionsProduct: boolean; updatedAt: Date }[],
): ParticipationHistoryItem[] {
  return posts.map((p) => ({ postedAt: p.updatedAt, mentionedProduct: p.mentionsProduct }));
}
