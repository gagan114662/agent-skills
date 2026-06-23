import { describe, expect, it } from "vitest";
import { isFeedbackChannel, triageFeedback } from "../../src/planning/feedback.js";

describe("planning feedback intake (#623)", () => {
  it("validates the supported real-feedback channels", () => {
    expect(isFeedbackChannel("in_app")).toBe(true);
    expect(isFeedbackChannel("email")).toBe(true);
    expect(isFeedbackChannel("support")).toBe(true);
    expect(isFeedbackChannel("slack")).toBe(false);
  });

  it("triages raw feedback into a customer-voice backlog draft", () => {
    const triaged = triageFeedback({
      channel: "support",
      reporter: "dana@northwind.co",
      url: "https://helpdesk.local/tickets/42",
      text: "The checkout is broken and we cannot pay for the team plan.",
    });

    expect(triaged.title).toBe("User feedback: The checkout is broken and we cannot pay for the team plan.");
    expect(triaged.sourceRef).toBe("feedback:support:the-checkout-is-broken-and-we-cannot-pay-for-th");
    expect(triaged.description).toContain("Channel: support");
    expect(triaged.description).toContain("Reporter: dana@northwind.co");
    expect(triaged.description).toContain("Receipt: https://helpdesk.local/tickets/42");
    expect(triaged.evidence).toEqual({
      signalCount: 1,
      severityTier: 3,
      corroboratingSources: 3,
      effortPoints: 2,
    });
  });
});
