import { describe, it, expect } from "vitest";
import { classifyFeedback } from "../../src/voice/classify.js";

describe("voice/classify — pure sentiment / churn-risk / category extraction (#114)", () => {
  it("an NPS score dominates: 0–6 detractor → negative + high churn", () => {
    const c = classifyFeedback({ sourceKind: "nps", text: "meh", npsScore: 3 });
    expect(c.sentiment).toBe("negative");
    expect(c.churnRisk).toBe("high");
    expect(c.signals).toContain("nps_detractor");
  });

  it("NPS 7–8 passive → neutral + medium; 9–10 promoter → positive + low + praise", () => {
    const passive = classifyFeedback({ sourceKind: "nps", text: "", npsScore: 7 });
    expect(passive.sentiment).toBe("neutral");
    expect(passive.churnRisk).toBe("medium");

    const promoter = classifyFeedback({ sourceKind: "nps", text: "love it", npsScore: 10 });
    expect(promoter.sentiment).toBe("positive");
    expect(promoter.churnRisk).toBe("low");
    expect(promoter.category).toBe("praise");
  });

  it("a cancellation is negative + high churn + churn category regardless of mild wording", () => {
    const c = classifyFeedback({ sourceKind: "cancellation", text: "moving on" });
    expect(c.sentiment).toBe("negative");
    expect(c.churnRisk).toBe("high");
    expect(c.category).toBe("churn");
  });

  it("a support ticket about a crash is negative, a bug, and at least medium churn", () => {
    const c = classifyFeedback({ sourceKind: "support_ticket", text: "The app keeps crashing with an error, totally broken" });
    expect(c.sentiment).toBe("negative");
    expect(c.category).toBe("bug");
    expect(["medium", "high"]).toContain(c.churnRisk);
  });

  it("churn keywords (too expensive, refund) raise churn-risk to high and route to pricing", () => {
    const c = classifyFeedback({ sourceKind: "support_ticket", text: "This is too expensive, I want a refund" });
    expect(c.churnRisk).toBe("high");
    expect(c.category).toBe("pricing");
  });

  it("praise is positive and categorised praise", () => {
    const c = classifyFeedback({ sourceKind: "support_ticket", text: "I love this, it's amazing and so helpful, thank you!" });
    expect(c.sentiment).toBe("positive");
    expect(c.category).toBe("praise");
    expect(c.churnRisk).toBe("low");
  });

  it("a feature request is routed to feature_request", () => {
    const c = classifyFeedback({ sourceKind: "support_ticket", text: "Would love if you could please add a dark mode feature" });
    expect(c.category).toBe("feature_request");
  });

  it("a checkout abandon defaults to medium churn (a soft signal, not a cancellation)", () => {
    const c = classifyFeedback({ sourceKind: "checkout_abandon", text: "" });
    expect(c.churnRisk).toBe("medium");
  });

  it("classifies negative brand mentions so the monitor can flag response-needed items (#618)", () => {
    const c = classifyFeedback({ sourceKind: "brand_mention", text: "ipop.ai is broken and confusing" });
    expect(c.sentiment).toBe("negative");
    expect(c.category).toBe("bug");
    expect(c.churnRisk).toBe("medium");
  });

  it("is deterministic and total (empty text never throws)", () => {
    const a = classifyFeedback({ sourceKind: "support_ticket", text: "" });
    const b = classifyFeedback({ sourceKind: "support_ticket", text: "" });
    expect(a).toEqual(b);
    expect(a.category).toBe("support");
  });
});
