/**
 * App-wide dark theme gate (#378). Proves the theme is applied only when the flag is on, and that with the
 * flag off the document root carries NO `data-theme` (the default paper palette — prod byte-for-byte today).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyReloadTheme, reloadThemeName, RELOAD_DARK_THEME } from "./theme.js";

afterEach(() => document.documentElement.removeAttribute("data-theme"));

const HERE = dirname(fileURLToPath(import.meta.url));

describe("reloadThemeName", () => {
  it("returns the dark theme name when the flag is on", () => {
    expect(reloadThemeName(true)).toBe(RELOAD_DARK_THEME);
  });
  it("returns null when the flag is off (default light palette)", () => {
    expect(reloadThemeName(false)).toBeNull();
  });
});

describe("applyReloadTheme", () => {
  it("stamps data-theme on the root when on", () => {
    applyReloadTheme(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe(RELOAD_DARK_THEME);
  });

  it("removes data-theme when off (never stuck dark)", () => {
    document.documentElement.setAttribute("data-theme", RELOAD_DARK_THEME);
    applyReloadTheme(false);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("dark theme tokens in styles.css", () => {
  const css = readFileSync(resolve(HERE, "styles.css"), "utf8");

  it("scopes the dark palette to the gated data-theme selector and overrides the core bg/text tokens", () => {
    const block = css.match(/:root\[data-theme="reload-dark"\]\s*\{([^}]*)\}/);
    expect(block, "dark theme override block must exist").not.toBeNull();
    const body = block![1]!;
    // The whole app keys off these tokens, so the dark look must redefine them (not leave them paper).
    expect(body).toMatch(/--bg:/);
    expect(body).toMatch(/--text:/);
    expect(body).toMatch(/--bg-1:/);
  });

  it("the default :root palette stays light (prod, no data-theme, is byte-for-byte today)", () => {
    const root = css.match(/:root\s*\{([^}]*)\}/);
    expect(root![1]).toMatch(/--bg:\s*#f6f1e7/); // paper, unchanged
  });
});
