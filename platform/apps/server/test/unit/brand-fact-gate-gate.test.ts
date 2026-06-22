/**
 * Unit tests for the publish gate + caps (issue #627, `brand-fact-gate/gate.ts` + `caps.ts`).
 */

import { describe, it, expect } from "vitest";
import {
  gatePublish,
  DEFAULT_PUBLISH_GATE_POLICY,
  resolvePublishGatePolicy,
  type PublishGatePolicy,
} from "../../src/brand-fact-gate/index.js";

describe("gatePublish — passes only clean, sourced, on-brand drafts", () => {
  it("passes an on-brand draft with no checkable claims", () => {
    const d = gatePublish({ content: "Acme helps support teams resolve tickets faster. Onboarding takes a day." });
    expect(d.allowed).toBe(true);
    expect(d.outcome).toBe("pass");
    expect(d.failed).toEqual([]);
    expect(d.revisionNotes).toEqual([]);
  });

  it("passes an on-brand draft whose factual claim carries a source", () => {
    const d = gatePublish({
      content: "Our customers cut resolution time by 40% on average, per a 2025 Forrester study [1].",
    });
    expect(d.allowed).toBe(true);
    expect(d.facts.claims).toHaveLength(1);
    expect(d.facts.unsourced).toEqual([]);
  });
});

describe("gatePublish — blocks and routes back for revision (the #627 core)", () => {
  it("blocks an off-brand draft on the voice axis with concrete revision notes", () => {
    const d = gatePublish({ content: "You won't believe this revolutionary, 100% guaranteed game-changer!!!" });
    expect(d.allowed).toBe(false);
    expect(d.outcome).toBe("revise");
    expect(d.failed).toContain("voice");
    expect(d.revisionNotes.length).toBeGreaterThan(0);
  });

  it("blocks an ON-brand draft purely for an unsourced claim (fact axis is independent)", () => {
    const d = gatePublish({ content: "Our customers save 40% on support costs on average." });
    expect(d.allowed).toBe(false);
    expect(d.failed).toEqual(["facts"]);
    expect(d.revisionNotes.some((n) => n.toLowerCase().includes("source"))).toBe(true);
  });

  it("fails closed on an empty draft — there is nothing to publish", () => {
    const d = gatePublish({ content: "   " });
    expect(d.allowed).toBe(false);
    expect(d.failed).toEqual(["empty"]);
  });

  it("tolerates a malformed input object without throwing (fail-closed)", () => {
    // @ts-expect-error — exercising the total-function guard
    const d = gatePublish(null);
    expect(d.allowed).toBe(false);
    expect(d.failed).toContain("empty");
  });
});

describe("gatePublish — additive / one-directional invariant", () => {
  it("a relaxed policy still cannot turn a hard failure into a pass", () => {
    // Most permissive policy a workspace can express: no voice floor, unlimited unsourced claims tolerated.
    // High-severity flags remain (they are the non-negotiable safety floor).
    const relaxed: PublishGatePolicy = {
      minVoiceScore: 0,
      maxUnsourcedClaims: Number.MAX_SAFE_INTEGER,
      blockOnHighSeverityVoice: true,
      blockOnHighSeverityFact: true,
    };
    const d = gatePublish({ content: "You won't believe this — results are 100% guaranteed!" }, relaxed);
    expect(d.allowed).toBe(false);
    expect(d.failed).toContain("voice");
  });

  it("raising the voice floor only ever makes the gate stricter", () => {
    const draft = { content: "Our revolutionary tool is a game-changer." }; // medium hype, score 86
    const lenient = gatePublish(draft, { ...DEFAULT_PUBLISH_GATE_POLICY, minVoiceScore: 50 });
    const strict = gatePublish(draft, { ...DEFAULT_PUBLISH_GATE_POLICY, minVoiceScore: 90 });
    expect(lenient.allowed).toBe(true);
    expect(strict.allowed).toBe(false);
  });
});

describe("resolvePublishGatePolicy — self-contained env config", () => {
  it("defaults to the strict baseline with no env set", () => {
    expect(resolvePublishGatePolicy({})).toEqual(DEFAULT_PUBLISH_GATE_POLICY);
  });

  it("reads valid overrides from the environment", () => {
    const p = resolvePublishGatePolicy({
      BRAND_FACT_GATE_MIN_VOICE_SCORE: "85",
      BRAND_FACT_GATE_MAX_UNSOURCED: "3",
      BRAND_FACT_GATE_BLOCK_HIGH_VOICE: "off",
      BRAND_FACT_GATE_BLOCK_HIGH_FACT: "off",
    });
    expect(p).toEqual({
      minVoiceScore: 85,
      maxUnsourcedClaims: 3,
      blockOnHighSeverityVoice: false,
      blockOnHighSeverityFact: false,
    });
  });

  it("falls back to defaults for invalid / out-of-range values", () => {
    const p = resolvePublishGatePolicy({
      BRAND_FACT_GATE_MIN_VOICE_SCORE: "9000",
      BRAND_FACT_GATE_MAX_UNSOURCED: "-2",
      BRAND_FACT_GATE_BLOCK_HIGH_VOICE: "maybe",
    });
    expect(p).toEqual(DEFAULT_PUBLISH_GATE_POLICY);
  });
});
