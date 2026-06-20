import { describe, it, expect } from "vitest";
import {
  marketingExpertise,
  MARKETING_STANDARDS,
  EXPERTISE_CHANNELS,
} from "../../../src/marketing/expertise.js";
import { MARKETING_DEPARTMENTS } from "../../../src/marketing/blueprint.js";

describe("marketing/expertise", () => {
  it("returns substantive, discipline-specific craft for every marketing channel", () => {
    for (const ch of EXPERTISE_CHANNELS) {
      const e = marketingExpertise(ch);
      expect(e.length).toBeGreaterThan(200); // real depth, not a one-liner
    }
  });

  it("each channel's expertise names a real framework of that discipline (not generic filler)", () => {
    expect(marketingExpertise("seo").toLowerCase()).toContain("intent");
    expect(marketingExpertise("seo").toLowerCase()).toContain("e-e-a-t");
    expect(marketingExpertise("social").toLowerCase()).toContain("first line");
    expect(marketingExpertise("content").toLowerCase()).toContain("distribution");
    expect(marketingExpertise("email").toLowerCase()).toContain("deliverability");
    expect(marketingExpertise("ads").toLowerCase()).toContain("cac");
    expect(marketingExpertise("analytics").toLowerCase()).toContain("north-star");
    expect(marketingExpertise("brand").toLowerCase()).toContain("positioning");
  });

  it("is case-insensitive and returns '' for an unknown channel (purely additive)", () => {
    expect(marketingExpertise("SEO")).toBe(marketingExpertise("seo"));
    expect(marketingExpertise("nonsense")).toBe("");
    expect(marketingExpertise("  email ")).toBe(marketingExpertise("email"));
  });

  it("MARKETING_STANDARDS encodes the cross-discipline bar (problem-first, specificity, one CTA, no vanity)", () => {
    const s = MARKETING_STANDARDS.toLowerCase();
    expect(s).toContain("problem");
    expect(s).toContain("specificity");
    expect(s).toContain("vanity");
  });

  it("every marketing department agent actually carries its discipline's expertise + the shared standards", () => {
    for (const d of MARKETING_DEPARTMENTS) {
      const expertise = marketingExpertise(d.channel);
      if (expertise) {
        // the agent's system prompt embeds a distinctive slice of its discipline's craft
        const probe = expertise.slice(40, 80);
        expect(d.agent.systemPrompt).toContain(probe);
      }
      expect(d.agent.systemPrompt).toContain("How great marketers operate");
      expect(d.agent.systemPrompt.toLowerCase()).toContain("world-class");
    }
  });
});
