import { describe, it, expect } from "vitest";
import {
  VOICE_DIMENSION,
  voiceDimensionScore,
  overlayVoiceDimension,
  type VoiceEvidence,
} from "../../src/voice/scorecard-evidence.js";
import { RUBRIC_DIMENSIONS, type PersonaScorecard } from "../../src/venture/rubric.js";

function card(v: number): PersonaScorecard {
  return Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, v])) as PersonaScorecard;
}

describe("voice/scorecard-evidence — the #96 ↔ #114 overlay (#114)", () => {
  it("overlays the problemSeverity dimension", () => {
    expect(VOICE_DIMENSION).toBe("problemSeverity");
  });

  it("strongly positive, low-churn voice scores high (>7)", () => {
    const ev: VoiceEvidence[] = [
      { sentiment: "positive", churnRisk: "low", npsScore: 10 },
      { sentiment: "positive", churnRisk: "low", npsScore: 9 },
    ];
    expect(voiceDimensionScore(ev)).toBeGreaterThan(7);
  });

  it("strongly negative, high-churn voice scores low (<3)", () => {
    const ev: VoiceEvidence[] = [
      { sentiment: "negative", churnRisk: "high", npsScore: 1 },
      { sentiment: "negative", churnRisk: "high", npsScore: 2 },
    ];
    expect(voiceDimensionScore(ev)).toBeLessThan(3);
  });

  it("clamps to 0–10 and is total on neutral evidence", () => {
    const s = voiceDimensionScore([{ sentiment: "neutral", churnRisk: "medium" }]);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(10);
  });

  it("overlayVoiceDimension replaces ONLY problemSeverity, leaving the rest untouched", () => {
    const base = card(5);
    const out = overlayVoiceDimension(base, 9);
    expect(out[VOICE_DIMENSION]).toBe(9);
    for (const d of RUBRIC_DIMENSIONS) {
      if (d !== VOICE_DIMENSION) expect(out[d]).toBe(5);
    }
    // pure: input not mutated
    expect(base[VOICE_DIMENSION]).toBe(5);
  });
});
