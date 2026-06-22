/**
 * Unit tests for the value-first drafting core (#597): relevance scoring, the "mention only when relevant"
 * decision, and the load-bearing invariant that a product mention ALWAYS carries the affiliation disclosure.
 */

import { describe, it, expect } from "vitest";
import { ANTI_SPAM_DEFAULTS } from "../../src/community/caps.js";
import {
  computeRelevance,
  containsDisclosure,
  draftReply,
  type DraftContext,
  type ProductContext,
} from "../../src/community/draft.js";
import type { CommunityThread } from "../../src/community/types.js";

const PRODUCT: ProductContext = {
  name: "ipop.ai",
  url: "https://ipop.ai",
  topics: ["ai", "marketing-automation", "growth"],
  disclosure: "(disclosure: I work on ipop.ai)",
};

function ctx(over: Partial<DraftContext> = {}): DraftContext {
  return { product: PRODUCT, policy: ANTI_SPAM_DEFAULTS, ...over };
}

function thread(topics: string[]): CommunityThread {
  return {
    id: "t-1",
    platform: "reddit",
    communityRef: "r/saas",
    title: "title",
    body: "body",
    url: null,
    ageHours: 4,
    replyCount: 1,
    topics,
  };
}

describe("computeRelevance (#597)", () => {
  it("is 1.0 when every thread topic overlaps our domain", () => {
    expect(computeRelevance(["ai", "growth"], PRODUCT.topics)).toBe(1);
  });

  it("is the fraction of the THREAD's topics that overlap (denominator = thread)", () => {
    expect(computeRelevance(["ai", "cooking"], PRODUCT.topics)).toBeCloseTo(0.5, 5);
    expect(computeRelevance(["ai", "growth", "cooking"], PRODUCT.topics)).toBeCloseTo(2 / 3, 5);
  });

  it("is 0 for no overlap and 0 for a thread with no topics", () => {
    expect(computeRelevance(["cooking", "sports"], PRODUCT.topics)).toBe(0);
    expect(computeRelevance([], PRODUCT.topics)).toBe(0);
  });

  it("is case-insensitive and de-duplicates topics", () => {
    expect(computeRelevance(["AI", "ai", "Growth"], PRODUCT.topics)).toBe(1);
  });
});

describe("containsDisclosure (#597)", () => {
  it("matches case-insensitively", () => {
    expect(containsDisclosure("... (DISCLOSURE: I work on ipop.ai)", PRODUCT.disclosure)).toBe(true);
    expect(containsDisclosure("no marker here", PRODUCT.disclosure)).toBe(false);
  });
});

describe("draftReply (#597)", () => {
  it("does NOT mention the product when relevance is below the mention threshold", () => {
    // ["ai","cooking"] ⇒ relevance 0.5 < 0.66 ⇒ helpful-only, no product, no disclosure.
    const d = draftReply(thread(["ai", "cooking"]), ctx());
    expect(d.mentionsProduct).toBe(false);
    expect(d.hasDisclosure).toBe(false);
    expect(d.body.toLowerCase()).not.toContain("ipop.ai");
    expect(d.body.toLowerCase()).not.toContain("disclosure");
  });

  it("mentions the product AND discloses affiliation when the thread is strongly relevant", () => {
    const d = draftReply(thread(["ai", "growth"]), ctx()); // relevance 1.0 ≥ 0.66
    expect(d.mentionsProduct).toBe(true);
    expect(d.hasDisclosure).toBe(true);
    expect(d.body).toContain("ipop.ai");
    expect(d.body).toContain("https://ipop.ai");
    expect(d.body).toContain(PRODUCT.disclosure);
  });

  it("INVARIANT: a mention always carries the disclosure (never one without the other)", () => {
    for (const topics of [["ai", "growth"], ["ai"], ["ai", "marketing-automation"], ["cooking"]]) {
      const d = draftReply(thread(topics), ctx());
      if (d.mentionsProduct) expect(d.hasDisclosure).toBe(true);
      // and a disclosure never appears without a mention
      if (!d.mentionsProduct) expect(d.body).not.toContain(PRODUCT.disclosure);
    }
  });

  it("leads with helpful content (value-first): provided points appear before any product mention", () => {
    const d = draftReply(thread(["ai", "growth"]), ctx({ helpfulPoints: ["Batch your API calls to cut latency"] }));
    expect(d.body).toMatch(/^Batch your API calls/);
    const helpfulIdx = d.body.indexOf("Batch your API calls");
    const productIdx = d.body.indexOf("ipop.ai");
    expect(helpfulIdx).toBeLessThan(productIdx);
  });

  it("uses the provided helpful points verbatim as the value content", () => {
    const d = draftReply(thread(["cooking"]), ctx({ helpfulPoints: ["Try a smaller batch size first"] }));
    expect(d.body).toContain("Try a smaller batch size first");
  });

  it("is deterministic: same inputs produce the same draft", () => {
    const t = thread(["ai", "growth"]);
    expect(draftReply(t, ctx())).toEqual(draftReply(t, ctx()));
  });
});
