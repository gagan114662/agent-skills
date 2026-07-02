import { describe, expect, it } from "vitest";
import {
  distillBrandVoiceEdit,
  renderBrandVoiceProfile,
} from "../../src/marketing/brand-voice-profile.js";

describe("brand voice profile learning (#1543)", () => {
  it("distills an owner rewrite into a structured voice profile update", () => {
    const suggestion = distillBrandVoiceEdit({
      currentVoice: "Warm, concise, never smug.",
      originalDraft: "Unlock guaranteed growth with our magical AI marketing platform!!!",
      editedDraft: "Show the receipt: Scout found the gap, Quill drafted the first useful move.",
      sourceUrls: ["https://acme.test"],
      learnedAt: "2026-07-01T00:00:00.000Z",
    });

    expect(suggestion.changed).toBe(true);
    expect(suggestion.confirmationRequired).toBe(true);
    expect(suggestion.artifact.kind).toBe("brand_voice");
    expect(suggestion.artifact.profile.toneAxes).toContain("calm confidence over hype");
    expect(suggestion.artifact.profile.vocabularyDo).toContain("receipt");
    expect(suggestion.artifact.profile.vocabularyDont).toContain("guaranteed");
    expect(suggestion.nextVoice).toContain("Existing voice notes: Warm, concise, never smug.");
    expect(suggestion.nextVoice).toContain("Avoid:");
  });

  it("renders the same profile deterministically for repeat injections", () => {
    const profile = {
      toneAxes: ["plain over hype"],
      vocabularyDo: ["receipts"],
      vocabularyDont: ["magic"],
      sentenceRhythm: "Short setup, concrete payoff.",
      exampleLines: ["Scout found the proof."],
    };

    expect(renderBrandVoiceProfile(profile, "Warm.")).toBe(renderBrandVoiceProfile(profile, "Warm."));
  });
});
