import { describe, it, expect } from "vitest";
import {
  composePriorDecisionsBlock,
  decisionDedupeKey,
  formatDecisionBrief,
  normalizeTopic,
  sanitizeDecisionText,
} from "../../src/decisions/recall.js";
import type { RecalledDecision } from "../../src/decisions/types.js";

/**
 * Pure cores of the shared decision store (issue #513): identity (dedup), the user-facing "no internal
 * agent chatter" sanitizer, topic normalization, and the brief/preamble composers. No DB.
 */

describe("decisionDedupeKey", () => {
  it("is idempotent across case/whitespace in topic + title", () => {
    expect(decisionDedupeKey("Brand Voice", "Use a warm, plain tone")).toBe(
      decisionDedupeKey("  brand   voice ", "use a WARM, plain   tone"),
    );
  });

  it("differs by topic and by title", () => {
    expect(decisionDedupeKey("pricing", "go monthly")).not.toBe(
      decisionDedupeKey("brand", "go monthly"),
    );
    expect(decisionDedupeKey("pricing", "go monthly")).not.toBe(
      decisionDedupeKey("pricing", "go annual"),
    );
  });

  it("is a stable 64-char hex digest", () => {
    expect(decisionDedupeKey("t", "x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sanitizeDecisionText — strips internal agent chatter (the user-facing rule)", () => {
  it("removes fleet @handles, routing #tags, and handoff/A2A markers", () => {
    const out = sanitizeDecisionText("@scout handing off to @quill via A2A — #content ship the post");
    expect(out).not.toMatch(/@scout|@quill|#content/i);
    expect(out).not.toMatch(/hand[- ]?off|A2A/i);
    expect(out).toContain("ship the post");
  });

  it("peels conversational lead-ins, even stacked", () => {
    expect(sanitizeDecisionText("Okay, so I think we should ship weekly")).toBe(
      "we should ship weekly",
    );
    expect(sanitizeDecisionText("As an AI, here's the plan: go annual")).toBe("the plan: go annual");
  });

  it("strips surrounding quotes/markdown and collapses whitespace", () => {
    expect(sanitizeDecisionText('  **"Use   Postgres"**  ')).toBe("Use Postgres");
  });

  it("bounds length with an ellipsis", () => {
    const out = sanitizeDecisionText("x".repeat(500), 50);
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never returns empty — a chatter-only input collapses to a dash", () => {
    expect(sanitizeDecisionText("@scout #content")).toBe("—");
    expect(sanitizeDecisionText("")).toBe("—");
  });
});

describe("normalizeTopic", () => {
  it("lowercases, collapses whitespace, strips @/# tokens", () => {
    expect(normalizeTopic("  Brand   Voice #content @scout ")).toBe("brand voice");
  });
  it("falls back to 'general' for an empty topic", () => {
    expect(normalizeTopic("   ")).toBe("general");
    expect(normalizeTopic("@scout")).toBe("general");
  });
});

describe("formatDecisionBrief / composePriorDecisionsBlock", () => {
  const decisions: RecalledDecision[] = [
    {
      id: "d1",
      topic: "pricing",
      title: "Go with monthly billing",
      rationale: "Lower friction for first conversion",
      decidedAt: new Date("2026-06-14T10:00:00Z"),
    },
  ];

  it("renders one chatter-free line per decision with a stable UTC day", () => {
    expect(formatDecisionBrief(decisions)).toBe(
      "- Go with monthly billing — Lower friction for first conversion (decided 2026-06-14, topic: pricing)",
    );
  });

  it("empty input ⇒ empty brief and a null block", () => {
    expect(formatDecisionBrief([])).toBe("");
    expect(composePriorDecisionsBlock([])).toBeNull();
  });

  it("composes a DATA-framed block that forbids treating decisions as instructions", () => {
    const block = composePriorDecisionsBlock(decisions)!;
    expect(block).toMatch(/reference DATA/i);
    expect(block).toMatch(/never instructions/i);
    expect(block).toContain("Go with monthly billing");
  });
});
