/**
 * Unit tests for the brand-voice checker (issue #627, `brand-fact-gate/voice.ts`). Pure function, so these
 * are exhaustive and deterministic — no fixtures, no IO.
 */

import { describe, it, expect } from "vitest";
import {
  checkBrandVoice,
  MAX_VOICE_SCORE,
  VOICE_PENALTY,
  EMPTY_VOICE_PROFILE,
} from "../../src/brand-fact-gate/voice.js";

describe("checkBrandVoice — clean content", () => {
  it("scores a professional, on-brand draft at the maximum with no findings", () => {
    const r = checkBrandVoice("Acme helps support teams resolve tickets faster. Onboarding takes about a day.");
    expect(r.score).toBe(MAX_VOICE_SCORE);
    expect(r.findings).toEqual([]);
    expect(r.worstSeverity).toBeNull();
  });

  it("treats empty / non-string input as clean (the gate, not the voice checker, blocks empty drafts)", () => {
    expect(checkBrandVoice("").score).toBe(MAX_VOICE_SCORE);
    // @ts-expect-error — exercising the total-function guard against non-string input
    expect(checkBrandVoice(null).findings).toEqual([]);
  });
});

describe("checkBrandVoice — built-in off-brand lexicon", () => {
  it("flags clickbait as high severity", () => {
    const r = checkBrandVoice("You won't believe what this tool does.");
    expect(r.findings.some((f) => f.kind === "clickbait" && f.severity === "high")).toBe(true);
    expect(r.score).toBe(MAX_VOICE_SCORE - VOICE_PENALTY.high);
  });

  it("flags absolute guarantees as high severity", () => {
    const r = checkBrandVoice("Sign up today — results are 100% guaranteed and totally risk-free.");
    expect(r.findings.some((f) => f.kind === "false-guarantee" && f.severity === "high")).toBe(true);
  });

  it("flags hype/buzzwords as medium severity", () => {
    const r = checkBrandVoice("Our revolutionary platform is a true game-changer.");
    expect(r.findings.some((f) => f.kind === "hype" && f.severity === "medium")).toBe(true);
    expect(r.worstSeverity).toBe("medium");
  });

  it("flags 3+ exclamation marks as shouting", () => {
    const r = checkBrandVoice("Limited time only!!!");
    expect(r.findings.some((f) => f.kind === "shouting")).toBe(true);
  });
});

describe("checkBrandVoice — density checks", () => {
  it("flags many ALL-CAPS words as shouting but tolerates allowed acronyms", () => {
    const shout = checkBrandVoice("MASSIVE SAVINGS EVENT TODAY");
    expect(shout.findings.some((f) => f.kind === "shouting")).toBe(true);

    const acronyms = checkBrandVoice("Our HTTPS API returns JSON and is documented in the FAQ.");
    expect(acronyms.findings.some((f) => f.kind === "shouting")).toBe(false);
  });

  it("flags emoji spam past the threshold", () => {
    const r = checkBrandVoice("Big news 🎉🎉🚀🚀🔥 for everyone");
    expect(r.findings.some((f) => f.kind === "emoji-spam")).toBe(true);
  });
});

describe("checkBrandVoice — brief-derived banned phrases", () => {
  it("flags a workspace-banned phrase as high severity", () => {
    const r = checkBrandVoice("We are clearly better than competitor names like Foo.", {
      bannedPhrases: ["competitor names"],
    });
    const banned = r.findings.find((f) => f.kind === "banned-phrase");
    expect(banned?.severity).toBe("high");
  });

  it("matches banned phrases literally (regex metacharacters are escaped)", () => {
    const r = checkBrandVoice("Price: $9.99 (a+b) special", { bannedPhrases: ["$9.99 (a+b)"] });
    expect(r.findings.some((f) => f.kind === "banned-phrase")).toBe(true);
  });

  it("ignores blank / non-string banned phrases without throwing", () => {
    const r = checkBrandVoice("totally fine copy", {
      // @ts-expect-error — exercising defensive filtering of malformed profile entries
      bannedPhrases: ["", "   ", 42, null],
    });
    expect(r.findings).toEqual([]);
  });
});

describe("checkBrandVoice — scoring is the audit trail", () => {
  it("score equals MAX minus the summed per-finding penalties, floored at 0", () => {
    const r = checkBrandVoice(
      "You won't believe this revolutionary game-changer — it is 100% guaranteed!!!",
      { bannedPhrases: ["foo"] },
    );
    const expected = Math.max(0, MAX_VOICE_SCORE - r.findings.reduce((s, f) => s + VOICE_PENALTY[f.severity], 0));
    expect(r.score).toBe(expected);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it("EMPTY_VOICE_PROFILE applies only the built-in lexicons", () => {
    expect(checkBrandVoice("plain professional copy", EMPTY_VOICE_PROFILE).findings).toEqual([]);
  });
});
