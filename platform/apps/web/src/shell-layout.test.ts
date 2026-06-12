/**
 * Shell layout overflow guard (#169). The workspace shell clipped content at standard window widths
 * (tested 901x628): the topbar's fixed-size flex children overflowed the viewport, forcing a horizontal
 * page scroll that pushed centered panels off-screen ("Connect Claude" → "Claude", "Pending" → "g").
 *
 * jsdom has no layout engine and the vitest config sets `css: false`, so we cannot measure scrollWidth
 * here. Instead this is a CSS-contract test: it reads the real stylesheet and asserts the specific
 * declarations that keep the shell from ever scrolling sideways. The visual proof (no horizontal scroll
 * at 800/901/1280 across Deploy/Settings/Automations/Approvals) is captured as before/after screenshots
 * in the PR. If someone removes one of these guards, this test fails and points at the regression.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// vitest runs with cwd at the web package root; the stylesheet is the one the app actually ships.
// Strip comments so prose like "it's `position:absolute`" inside a rule can't be parsed as a declaration.
const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Return the declaration body of the first top-level rule whose selector list exactly matches `selector`. */
function ruleBody(selector: string): string {
  // Match `selector {  ... }` (selector at the start of a line, not inside a media query is fine — we
  // only need the base declarations). Escape regex metachars in the selector.
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m");
  const m = re.exec(css);
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[1]!;
}

function decl(body: string, prop: string): string | null {
  // Lookbehind for `[-\w]` so searching `overflow` never matches `overflow-x` (and so a declaration that
  // follows a `/* comment */` — with no `;`/`{` immediately before it — still matches).
  const re = new RegExp(`(?<![-\\w])${prop}\\s*:\\s*([^;]+)`, "i");
  const m = re.exec(body);
  return m ? m[1]!.trim() : null;
}

describe("shell layout overflow guards (#169)", () => {
  it("never lets the page scroll sideways: body + workspace clip horizontal overflow", () => {
    expect(decl(ruleBody("body"), "overflow-x")).toBe("hidden");
    expect(decl(ruleBody(".workspace"), "overflow-x")).toBe("hidden");
    expect(decl(ruleBody(".workspace"), "max-width")).toBe("100%");
  });

  it("the topbar nav shrinks and scrolls within itself instead of pushing the row off-screen", () => {
    const nav = ruleBody(".topbar__nav");
    expect(decl(nav, "min-width")).toBe("0");
    expect(decl(nav, "overflow-x")).toBe("auto");
  });

  it("each nav tab keeps its full label (does not shrink) and anchors its badge to itself", () => {
    const btn = ruleBody(".topbar__navbtn");
    expect(decl(btn, "white-space")).toBe("nowrap");
    expect(decl(btn, "flex")).toBe("0 0 auto");
    // Anchoring the absolutely-positioned count/live badge to the button keeps it from poking past the
    // viewport's right edge (the residual 2px overflow we saw before this fix).
    expect(decl(btn, "position")).toBe("relative");
  });

  it("the approvals/policies tab anchors its count badge too (Approvals is one of the clipped views)", () => {
    expect(decl(ruleBody(".tab"), "position")).toBe("relative");
  });

  it("the identity label truncates rather than forcing the topbar wider", () => {
    const me = ruleBody(".topbar__me");
    expect(decl(me, "min-width")).toBe("0");
    expect(decl(me, "overflow")).toBe("hidden");
    expect(decl(me, "text-overflow")).toBe("ellipsis");
    expect(decl(me, "white-space")).toBe("nowrap");
  });

  it("the Deploy two-column grid can shrink its tracks below their content width", () => {
    expect(decl(ruleBody(".deploy__sidebar,\n.deploy__main"), "min-width")).toBe("0");
  });
});
