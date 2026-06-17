/**
 * Pure deliverable-presentation tests (#302). Lock the human title derivation, the internal/test filter,
 * the action-label map (no raw `x.y` ids ever), and the preview — the four things that turn a raw
 * `agent.deliverable` approval into a card a paying user can actually read.
 */
import { describe, expect, it } from "vitest";
import { CONSOLE } from "../../brand.js";
import {
  cleanDeliverableTitle,
  deliverablePreview,
  humanActionLabel,
  isInternalDeliverableTask,
  stripHarnessNoise,
} from "./deliverable.js";

/** The exact warning the agent CLI prints to stderr when launched with a connected-but-empty stdin. */
const STDIN_WARNING =
  "Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly:";

/** True if a UTF-16 string contains an unpaired surrogate — i.e. a code point was split mid-character. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // high surrogate must be followed by a low surrogate
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // lone low surrogate
    }
  }
  return false;
}

describe("cleanDeliverableTitle (#302)", () => {
  it("strips the 'Deliverable ready for review:' boilerplate prefix", () => {
    expect(cleanDeliverableTitle("Deliverable ready for review: Audit the homepage")).toBe(
      "Audit the homepage",
    );
  });

  it("cuts the URL / 'fetch …' mechanics so only the human description remains", () => {
    const t = cleanDeliverableTitle("Audit the live homepage for SEO… fetch https://example.com/x");
    expect(t).toBe("Audit the live homepage for SEO");
    expect(t).not.toMatch(/https?:\/\//);
    expect(t).not.toMatch(/fetch/i);
  });

  it("sentence-cases and truncates a long task", () => {
    const long = "review every page on the marketing site and rewrite the meta descriptions for each one in turn carefully";
    const t = cleanDeliverableTitle(long);
    expect(t.startsWith("R")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(64);
    expect(t.endsWith("…")).toBe(true);
  });

  it("returns empty string when nothing usable remains (caller falls back to a brand string)", () => {
    expect(cleanDeliverableTitle("")).toBe("");
    expect(cleanDeliverableTitle("fetch https://x.test")).toBe("");
    expect(cleanDeliverableTitle(null)).toBe("");
  });

  it("truncates by code points — an emoji on the 64-char boundary is never split", () => {
    // 62 ASCII + an astral emoji (2 UTF-16 units) lands the surrogate pair exactly on the slice(0,63)
    // boundary; a UTF-16 slice would emit a lone high surrogate.
    const t = cleanDeliverableTitle("a".repeat(62) + "😀" + "bbbbbb");
    expect(hasLoneSurrogate(t)).toBe(false);
    expect([...t].length).toBeLessThanOrEqual(64);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("isInternalDeliverableTask (#302)", () => {
  it("flags the canonical internal QA probe", () => {
    expect(
      isInternalDeliverableTask("Reply with one sentence confirming you can run, then stop"),
    ).toBe(true);
  });

  it("flags it even behind the review-prefix boilerplate", () => {
    expect(
      isInternalDeliverableTask("Deliverable ready for review: reply with one sentence confirming you can run"),
    ).toBe(true);
  });

  it("does NOT flag a real customer deliverable", () => {
    expect(isInternalDeliverableTask("Audit our homepage for SEO quick wins")).toBe(false);
    expect(isInternalDeliverableTask(undefined)).toBe(false);
  });
});

describe("humanActionLabel (#302)", () => {
  it("maps the internal deliverable type to a human label — never the raw id", () => {
    const label = humanActionLabel("agent.deliverable");
    expect(label).toBe(CONSOLE.deliverable.actionLabels["agent.deliverable"]);
    expect(label).not.toContain("agent.deliverable");
  });

  it("maps known action types and falls back to a human word for unknown ones", () => {
    expect(humanActionLabel("external.send")).toBe(CONSOLE.deliverable.actionLabels["external.send"]);
    expect(humanActionLabel("some.unknown.type")).toBe(CONSOLE.deliverable.actionFallback);
    expect(humanActionLabel(undefined)).toBe(CONSOLE.deliverable.actionFallback);
    // The fallback is never a raw dotted id.
    expect(humanActionLabel("some.unknown.type")).not.toContain(".");
  });
});

describe("stripHarnessNoise (stdin-warning leak)", () => {
  it("removes the leading stdin warning so only the real content remains", () => {
    const real = "Here's a tweet draft: Ship calm, ship daily. 🚀";
    expect(stripHarnessNoise(`${STDIN_WARNING}\n${real}`)).toBe(real);
  });

  it("removes the warning plus its blank gap and redirect-example continuation", () => {
    const real = "Line one of the deliverable.\nLine two stays intact.";
    const raw = `${STDIN_WARNING}\n\n  cat input.txt | claude -p\n${real}`;
    expect(stripHarnessNoise(raw)).toBe(real);
  });

  it("leaves a clean draft untouched", () => {
    const real = "A perfectly clean deliverable.\nWith two lines.";
    expect(stripHarnessNoise(real)).toBe(real);
  });

  it("only strips LEADING noise — a later line that resembles noise is preserved", () => {
    const raw = "Real first line.\nWarning: no stdin data received in 3s (quoted in the body).";
    expect(stripHarnessNoise(raw)).toBe(raw);
  });

  it("handles empty / nullish input", () => {
    expect(stripHarnessNoise("")).toBe("");
    expect(stripHarnessNoise(null)).toBe("");
    expect(stripHarnessNoise(undefined)).toBe("");
  });
});

describe("deliverablePreview (#302)", () => {
  it("takes the first non-empty line, trimmed and truncated", () => {
    expect(deliverablePreview("\n\n  Found 3 quick wins  \nmore detail")).toBe("Found 3 quick wins");
    expect(deliverablePreview("")).toBe("");
    expect(deliverablePreview(null)).toBe("");
  });

  it("skips the leading stdin warning and previews the real content", () => {
    const draft = `${STDIN_WARNING}\nShip calm, ship daily.\nmore detail`;
    expect(deliverablePreview(draft)).toBe("Ship calm, ship daily.");
    expect(deliverablePreview(draft)).not.toMatch(/no stdin data received/i);
  });

  it("truncates a very long first line", () => {
    const p = deliverablePreview("x".repeat(400));
    expect([...p].length).toBeLessThanOrEqual(120);
    expect(p.endsWith("…")).toBe(true);
  });

  it("truncates by code points — an emoji on the 120-char boundary is never split", () => {
    const p = deliverablePreview("a".repeat(118) + "😀" + "ccccc");
    expect(hasLoneSurrogate(p)).toBe(false);
    expect([...p].length).toBeLessThanOrEqual(120);
    expect(p.endsWith("…")).toBe(true);
  });
});
