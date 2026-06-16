/**
 * Regression guard for #234 / #287 — the Upgrade modal ("Pick your pop") rendered ONLY the cheapest
 * Starter card; Pro ($199) and Agency ($499) were in the DOM but invisible, hiding ~80% of revenue tiers.
 *
 * Root cause (see ADR-0234): the three plan cards are laid out in a correct 3-column grid (proven live —
 * the public `/pricing` page uses the identical `.pricing__grid` markup and renders all three), but each
 * card's *visibility* was gated on a CSS entrance animation. `.pricing-card--pop` rested at `opacity: 0`
 * and only flipped to visible if the `pricing-pop` keyframe animation ran to completion. When that
 * animation didn't complete for a card (the modal's async mount path / staggered `animation-delay`),
 * the card stayed permanently invisible while still occupying its grid track — Starter on the left,
 * empty space where Pro and Agency should be.
 *
 * The invariant this test pins: a plan card must be VISIBLE AT REST. Visibility must never depend on an
 * animation completing — the pop is a progressive enhancement, not a gate. jsdom can't compute CSS
 * animations, so we assert the invariant against the stylesheet source directly (same approach as
 * brand.test.ts, which scans source files).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../styles.css"), "utf8");

/** Extract the body of the first (non-media-query) `.pricing-card--pop { … }` rule. */
function popRuleBody(): string {
  const start = css.indexOf(".pricing-card--pop {");
  expect(start, "the .pricing-card--pop rule must exist").toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("pricing card visibility (#234/#287 — every tier must render)", () => {
  it("plan cards rest VISIBLE — visibility is not gated on the entrance animation", () => {
    const body = popRuleBody();
    // The bug: `opacity: 0` at rest meant a card the animation didn't reach stayed invisible forever.
    expect(body, "a plan card must not rest at opacity:0 (it would be invisible if the pop never runs)")
      .not.toMatch(/opacity\s*:\s*0\s*;/);
  });

  it("keeps the pop entrance — the animation pre-fills the hidden start (backwards/both)", () => {
    const body = popRuleBody();
    const animation = /animation\s*:[^;]*;/.exec(body)?.[0] ?? "";
    expect(animation, "the entrance pop should still be present").toMatch(/pricing-pop/);
    // `backwards`/`both` makes the card hidden during the pre-animation delay yet visible at rest,
    // so the pop is preserved without `opacity:0` ever being the resting (un-animated) state.
    expect(animation, "fill mode must pre-fill the hidden start so the pop survives without gating rest")
      .toMatch(/\b(backwards|both)\b/);
  });

  it("reduced-motion users also see every card (no animation, full opacity)", () => {
    // The reduced-motion override must keep cards visible (it disables the animation entirely).
    const rm = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.pricing-card--pop\s*\{([\s\S]*?)\}/.exec(
      css,
    );
    expect(rm, "a reduced-motion override for .pricing-card--pop must exist").not.toBeNull();
    const body = rm?.[1] ?? "";
    expect(body).toMatch(/opacity\s*:\s*1/);
    expect(body).toMatch(/animation\s*:\s*none/);
  });
});
