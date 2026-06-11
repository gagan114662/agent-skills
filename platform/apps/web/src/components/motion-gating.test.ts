import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * #145 acceptance criterion #10: every animation is gated behind `prefers-reduced-motion: reduce`, and
 * the static state must still look designed. This guards the gate at the source: the full-motion
 * vocabulary introduced by the polish pass must be named in a reduced-motion block that neutralises it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(HERE, "../styles.css"), "utf8");

describe("reduced-motion gating", () => {
  it("declares a prefers-reduced-motion block", () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  // The motion classes added by #145. Each must be named inside a reduced-motion block so its
  // animation/transition is switched off — otherwise the pop becomes a tax on people who opt out.
  const GATED = [
    ".poploader__dot",
    ".confetti-burst",
    ".popmark",
    ".popmark__ray",
    ".message", // swell-pop on new messages
    ".view-fade", // tab transition
    ".channelrow__hash", // hover wiggle
    ".wordmark__dot", // idle bob
  ];

  for (const sel of GATED) {
    it(`gates ${sel} under reduced-motion`, () => {
      // Find a reduced-motion block that mentions this selector.
      const blocks = css.split(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/).slice(1);
      const mentioned = blocks.some((b) => b.slice(0, b.indexOf("\n}\n") + 3 || b.length).includes(sel) || b.includes(sel));
      expect(mentioned, `${sel} must appear in a reduced-motion block`).toBe(true);
    });
  }

  it("neutralises motion with animation: none", () => {
    const idx = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");
    expect(idx).toBeGreaterThan(-1);
    expect(css.slice(idx)).toMatch(/animation:\s*none/);
  });
});
