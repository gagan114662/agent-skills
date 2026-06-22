/**
 * Unit tests for the anti-spam / relevance gate (#597) — the centerpiece guardrail. Each rule is exercised in
 * isolation (one violated knob at a time) plus the fail-closed accumulation of multiple violations, the
 * happy-path allow, and the reporting fields (relevance, promoRatioAfter, repliesInWindow).
 */

import { describe, it, expect } from "vitest";
import { ANTI_SPAM_DEFAULTS, type AntiSpamPolicy } from "../../src/community/caps.js";
import {
  evaluateGate,
  isAllowed,
  historyFromPosts,
  type GateCode,
  type ParticipationHistoryItem,
} from "../../src/community/gate.js";
import type { CommunityThread, ParticipationDraft } from "../../src/community/types.js";

const NOW = new Date("2026-01-15T00:00:00.000Z");
const HOUR = 3_600_000;

function thread(over: Partial<CommunityThread> = {}): CommunityThread {
  return {
    id: "t-1",
    platform: "reddit",
    communityRef: "r/saas",
    title: "title (DATA)",
    body: "body (DATA)",
    url: null,
    ageHours: 5,
    replyCount: 2,
    topics: ["ai", "growth"],
    ...over,
  };
}

/** A clean, helpful (non-promo) draft that clears every rule by default. */
function draft(over: Partial<ParticipationDraft> = {}): ParticipationDraft {
  return {
    body: "Here is a genuinely useful and reasonably long answer that comfortably clears the minimum word floor without any trouble at all, since it carries more than enough real substance.",
    mentionsProduct: false,
    hasDisclosure: false,
    relevance: 0.8,
    ...over,
  };
}

function evalWith(opts: {
  thread?: Partial<CommunityThread>;
  draft?: Partial<ParticipationDraft>;
  history?: ParticipationHistoryItem[];
  policy?: Partial<AntiSpamPolicy>;
  now?: Date;
}) {
  return evaluateGate({
    thread: thread(opts.thread),
    draft: draft(opts.draft),
    history: opts.history ?? [],
    policy: { ...ANTI_SPAM_DEFAULTS, ...opts.policy },
    now: opts.now ?? NOW,
  });
}

const codes = (d: { reasons: { code: GateCode }[] }) => d.reasons.map((r) => r.code);

describe("evaluateGate anti-spam gate (#597)", () => {
  it("allows a relevant, fresh, substantive, non-promotional reply with no history", () => {
    const d = evalWith({});
    expect(d.decision).toBe("allow");
    expect(isAllowed(d)).toBe(true);
    expect(d.reasons).toHaveLength(0);
    expect(d.promoRatioAfter).toBe(0); // 0 promo of 1 total
    expect(d.repliesInWindow).toBe(0);
  });

  it("blocks a thread below the relevance floor", () => {
    const d = evalWith({ draft: { relevance: 0.1 } });
    expect(d.decision).toBe("block");
    expect(codes(d)).toContain("not_relevant");
  });

  it("blocks necroing a thread older than the freshness cap", () => {
    const d = evalWith({ thread: { ageHours: ANTI_SPAM_DEFAULTS.maxThreadAgeHours + 1 } });
    expect(codes(d)).toContain("thread_too_old");
  });

  it("blocks a reply that is too short to be value-first", () => {
    const d = evalWith({ draft: { body: "too short" } });
    expect(codes(d)).toContain("reply_too_short");
  });

  it("blocks a product mention that omits the affiliation disclosure (fail-closed)", () => {
    // High enough relevance to mention; flagged as mentioning but with no disclosure.
    const d = evalWith({
      draft: { relevance: 0.9, mentionsProduct: true, hasDisclosure: false },
      // give promo room so ONLY the disclosure rule fires
      history: nonPromo(5, 100),
    });
    expect(codes(d)).toContain("undisclosed_affiliation");
  });

  it("a disclosed product mention with a track record passes the disclosure + promo rules", () => {
    const d = evalWith({
      draft: { relevance: 0.9, mentionsProduct: true, hasDisclosure: true },
      history: nonPromo(3, 100), // 3 old non-promo replies ⇒ promo ratio 1/4 = 0.25, not over the 0.25 cap
    });
    expect(d.decision).toBe("allow");
    expect(d.promoRatioAfter).toBeCloseTo(0.25, 5);
  });

  it("blocks when a promo reply would push the self-promotion ratio over the cap", () => {
    // Only 1 old non-promo reply ⇒ promo ratio would be 1/2 = 0.5 > 0.25.
    const d = evalWith({
      draft: { relevance: 0.9, mentionsProduct: true, hasDisclosure: true },
      history: nonPromo(1, 100),
    });
    expect(codes(d)).toContain("promo_ratio_exceeded");
    expect(d.promoRatioAfter).toBeCloseTo(0.5, 5);
  });

  it("a purely-helpful reply NEVER violates the promo ratio, even amid promotional history", () => {
    const d = evalWith({
      draft: { mentionsProduct: false }, // helpful only
      history: [
        ...promo(5, 100), // lots of past promo, but this reply isn't promotional
      ],
    });
    expect(codes(d)).not.toContain("promo_ratio_exceeded");
  });

  it("blocks when the per-window rate limit is already saturated", () => {
    // 3 replies inside the last 24h ⇒ at the maxRepliesPerWindow=3 cap.
    const d = evalWith({
      history: [item(1), item(2), item(3)],
      policy: { minHoursBetweenReplies: 0 }, // isolate the rate-limit rule from cooldown
    });
    expect(codes(d)).toContain("rate_limited");
    expect(d.repliesInWindow).toBe(3);
  });

  it("blocks when the cooldown since the last reply has not elapsed", () => {
    const d = evalWith({
      history: [item(2)], // 2h ago < 6h cooldown
      policy: { maxRepliesPerWindow: 100 }, // isolate cooldown from rate limit
    });
    expect(codes(d)).toEqual(["cooldown_active"]);
  });

  it("respects the rate window: replies outside it do not count", () => {
    const d = evalWith({
      history: [item(48), item(72)], // both older than the 24h window
      policy: { minHoursBetweenReplies: 0 },
    });
    expect(d.repliesInWindow).toBe(0);
    expect(d.decision).toBe("allow");
  });

  it("is fail-closed: multiple violations all surface and force a block", () => {
    const d = evalWith({
      draft: { relevance: 0.05, body: "tiny" },
      thread: { ageHours: 99999 },
    });
    expect(d.decision).toBe("block");
    expect(codes(d)).toEqual(
      expect.arrayContaining(["not_relevant", "reply_too_short", "thread_too_old"]),
    );
    expect(d.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("every blocking reason carries a human-readable message", () => {
    const d = evalWith({ draft: { relevance: 0.1 } });
    expect(d.reasons[0]?.message).toMatch(/relevance/i);
  });

  it("historyFromPosts maps posted records to history items", () => {
    const items = historyFromPosts([
      { mentionsProduct: true, updatedAt: NOW },
      { mentionsProduct: false, updatedAt: new Date(NOW.getTime() - HOUR) },
    ]);
    expect(items).toEqual([
      { postedAt: NOW, mentionedProduct: true },
      { postedAt: new Date(NOW.getTime() - HOUR), mentionedProduct: false },
    ]);
  });
});

/** A history item posted `hoursAgo` before NOW (non-promo by default). */
function item(hoursAgo: number, mentionedProduct = false): ParticipationHistoryItem {
  return { postedAt: new Date(NOW.getTime() - hoursAgo * HOUR), mentionedProduct };
}

/** `n` non-promotional replies, all `hoursAgo` before NOW (old enough to clear rate/cooldown). */
function nonPromo(n: number, hoursAgo: number): ParticipationHistoryItem[] {
  return Array.from({ length: n }, (_, i) => item(hoursAgo + i, false));
}

/** `n` promotional replies, all `hoursAgo` before NOW. */
function promo(n: number, hoursAgo: number): ParticipationHistoryItem[] {
  return Array.from({ length: n }, (_, i) => item(hoursAgo + i, true));
}
