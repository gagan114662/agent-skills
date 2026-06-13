import { describe, it, expect } from "vitest";
import { detectEscalation, KB_CONFIDENCE_FLOOR } from "../../src/support/escalation.js";

const base = {
  category: "support" as const,
  sentiment: "neutral" as const,
  churnRisk: "low" as const,
  kbConfidence: 0.9,
};

describe("support/escalation — quarantined risk detection (#190)", () => {
  it("a refund intent escalates with reason 'refund'", () => {
    const r = detectEscalation({ ...base, body: "I want a refund please" });
    expect(r.escalate).toBe(true);
    expect(r.reasons).toContain("refund");
  });

  it("a chargeback / money-back phrasing also triggers refund", () => {
    expect(detectEscalation({ ...base, body: "I'll do a chargeback" }).reasons).toContain("refund");
    expect(detectEscalation({ ...base, body: "give me my money back" }).reasons).toContain("refund");
  });

  it("legal threats escalate with reason 'legal'", () => {
    expect(detectEscalation({ ...base, body: "my attorney will file a lawsuit" }).reasons).toContain("legal");
    expect(detectEscalation({ ...base, body: "this violates GDPR, delete my data" }).reasons).toContain("legal");
  });

  it("explicit hostility escalates with reason 'anger'", () => {
    expect(detectEscalation({ ...base, body: "this is a scam you thieves" }).reasons).toContain("anger");
  });

  it("a strongly negative + high-churn message escalates as anger even without hostile keywords", () => {
    const r = detectEscalation({ ...base, body: "nothing works", sentiment: "negative", churnRisk: "high" });
    expect(r.reasons).toContain("anger");
  });

  it("low KB confidence escalates as 'unknown' — the desk never bluffs", () => {
    const r = detectEscalation({ ...base, body: "how do I export?", kbConfidence: KB_CONFIDENCE_FLOOR - 0.01 });
    expect(r.reasons).toContain("unknown");
  });

  it("a NaN/invalid KB confidence is treated as unknown (fail-safe)", () => {
    expect(detectEscalation({ ...base, body: "hi", kbConfidence: NaN }).reasons).toContain("unknown");
  });

  it("a clean, well-answered, calm message does NOT escalate", () => {
    const r = detectEscalation({ ...base, body: "how do I reset my password?", kbConfidence: 0.8 });
    expect(r.escalate).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("reasons are returned in stable order: refund, legal, anger, unknown", () => {
    const r = detectEscalation({
      ...base,
      body: "scam! my lawyer will sue and I want a refund",
      kbConfidence: 0.1,
      sentiment: "negative",
      churnRisk: "high",
    });
    expect(r.reasons).toEqual(["refund", "legal", "anger", "unknown"]);
  });
});
