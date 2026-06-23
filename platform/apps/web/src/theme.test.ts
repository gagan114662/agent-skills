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

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
  expect(match, selector + " rule must exist").not.toBeNull();
  return match![1]!;
}

function token(body: string, name: string): string {
  const match = body.match(new RegExp(name + ":\\s*(#[0-9a-fA-F]{6})"));
  expect(match, name + " token must be a hex color").not.toBeNull();
  return match![1]!;
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((part) => parseInt(part, 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(foreground: string, background: string): number {
  const fg = luminance(foreground);
  const bg = luminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

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

  it("keeps text and link tokens WCAG AA in both light and dark palettes", () => {
    const light = ruleBody(css, ":root");
    const dark = ruleBody(css, ':root[data-theme="reload-dark"]');

    for (const [body, label] of [[light, "light"], [dark, "dark"]] as const) {
      const bg = token(body, "--bg");
      for (const name of ["--text", "--text-dim", "--link"]) {
        expect(contrast(token(body, name), bg), label + " " + name + " contrast").toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("styles public nav links with theme colors instead of browser-default blue underlines", () => {
    for (const selector of [".site__nav-link", ".landing__nav-link"]) {
      const body = ruleBody(css, selector);
      expect(body).toMatch(/color:\s*var\(--text-dim\)/);
      expect(body).toMatch(/text-decoration:\s*none/);
    }
    expect(ruleBody(css, ".site__nav-link:hover")).toMatch(/color:\s*var\(--link\)/);
    expect(ruleBody(css, ".landing__nav-link:hover")).toMatch(/color:\s*var\(--link\)/);
  });
});
