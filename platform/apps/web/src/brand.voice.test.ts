import { describe, expect, it } from "vitest";
import { EVERYDAY, GARDEN, PAYWALL, VOICE } from "./brand.js";
import { ONBOARD_COPY, greeting } from "./components/onboarding/copy.js";

describe("brand voice surfaces (#1071)", () => {
  it("keeps greetings warm, lowercase, and action-oriented", () => {
    expect(greeting(14, "Gagan")).toBe(
      "afternoon, Gagan. right then — what are we making pop today?",
    );
    expect(EVERYDAY.greeting("Gagan", "morning")).toBe(
      "morning, gagan. right then — what are we making pop today?",
    );
  });

  it("turns empty states into cheeky nudges instead of dead ends", () => {
    expect(VOICE.emptyApprovals).toContain("go get a coffee");
    expect(VOICE.noPendingApprovals).toContain("we've got this");
    expect(EVERYDAY.thread.empty).toContain("cause a scene");
    expect(ONBOARD_COPY.empty).toContain("cause a scene");
  });

  it("names the money gate as human approval, not a generic warning", () => {
    expect(EVERYDAY.safety.moneyGate).toContain("your call");
    expect(ONBOARD_COPY.deliverable.moneyGate).toContain("big spender");
    expect(GARDEN.moneyGated).toBe("needs your yes");
    expect(PAYWALL.body).toContain("politely not spending");
  });

  it("celebrates the first customer in the defined house voice", () => {
    expect(EVERYDAY.celebrate.firstCustomer).toContain("someone just PAID you");
    expect(ONBOARD_COPY.shipped.firstCustomer).toContain("someone just PAID you");
  });
});
