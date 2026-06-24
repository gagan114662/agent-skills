import { describe, expect, it } from "vitest";
import {
  buildKeywordPrevalidationSignal,
  renderKeywordPrevalidation,
} from "../../src/marketing/content-cadence/prevalidation.js";

describe("content cadence SEO prevalidation (#884)", () => {
  it("stays honest when no external SEO provider is connected", () => {
    const signal = buildKeywordPrevalidationSignal({
      query: "ai agent marketing",
      provider: "dryrun",
      connected: false,
      trackedKeywords: ["ai agent marketing"],
      latest: [],
    });

    expect(signal.verdict).toBe("unvalidated");
    expect(signal.summary).toContain("No external SEO receipts");
    expect(renderKeywordPrevalidation(signal)).toContain("volume=unavailable");
  });

  it("validates page-one rank receipts but still asks Scout to verify intent", () => {
    const signal = buildKeywordPrevalidationSignal({
      query: "ai agent marketing",
      provider: "search_console",
      connected: true,
      trackedKeywords: ["ai agent marketing"],
      latest: [
        {
          keyword: "ai agent marketing",
          position: 4,
          url: "https://example.test/ai-agent-marketing",
          country: "us",
          observedAt: new Date("2026-06-24T12:00:00Z"),
        },
      ],
    });

    expect(signal.verdict).toBe("validated");
    expect(signal.evidence).toContain("bestPosition=4");
    expect(signal.evidence).toContain("intent=must be verified by Scout before drafting");
  });

  it("flags configured queries below page one as a winnability risk", () => {
    const signal = buildKeywordPrevalidationSignal({
      query: "ai agent marketing",
      provider: "serpapi",
      connected: true,
      trackedKeywords: ["ai agent marketing"],
      latest: [
        {
          keyword: "ai agent marketing",
          position: 37,
          url: "https://example.test/ai-agent-marketing",
          country: "us",
          observedAt: new Date("2026-06-24T12:00:00Z"),
        },
      ],
    });

    expect(signal.verdict).toBe("needs_review");
    expect(signal.summary).toContain("winnability risk");
  });
});
