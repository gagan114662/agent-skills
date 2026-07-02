import { describe, expect, it } from "vitest";
import { IPOP_PUBLIC_THEME, publicThemeStyle } from "./public-theme.js";

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

describe("public homepage theme tokens (#1532)", () => {
  it("anchors public routes to the homepage warm light palette", () => {
    expect(IPOP_PUBLIC_THEME.bg).toBe("#f6f1e7");
    expect(IPOP_PUBLIC_THEME.heroFill).toBe("#fff879");
    expect(IPOP_PUBLIC_THEME.text).toBe("#171310");
    expect(IPOP_PUBLIC_THEME.accent).toBe("#ff4524");
  });

  it("keeps public header/nav text AA on the warm page background", () => {
    expect(contrast(IPOP_PUBLIC_THEME.text, IPOP_PUBLIC_THEME.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#050505", IPOP_PUBLIC_THEME.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("exports the shared bg/surface/text/accent/border/radius/shadow contract", () => {
    const style = publicThemeStyle(["o"]);

    expect(style).toMatchObject({
      backgroundColor: IPOP_PUBLIC_THEME.bg,
      color: IPOP_PUBLIC_THEME.text,
      "--public-bg": IPOP_PUBLIC_THEME.bg,
      "--public-surface": IPOP_PUBLIC_THEME.surface,
      "--public-text": IPOP_PUBLIC_THEME.text,
      "--public-accent": IPOP_PUBLIC_THEME.accent,
      "--public-border": IPOP_PUBLIC_THEME.border,
      "--public-radius": IPOP_PUBLIC_THEME.radius,
      "--public-shadow": IPOP_PUBLIC_THEME.shadow,
      "--bg": IPOP_PUBLIC_THEME.bg,
      "--bg-1": IPOP_PUBLIC_THEME.raised,
      "--text": IPOP_PUBLIC_THEME.text,
      "--accent": IPOP_PUBLIC_THEME.accent,
      "--line": IPOP_PUBLIC_THEME.border,
      "--radius-lg": IPOP_PUBLIC_THEME.radius,
      "--shadow-lg": IPOP_PUBLIC_THEME.shadow,
      "--o-canvas": IPOP_PUBLIC_THEME.bg,
      "--o-text": IPOP_PUBLIC_THEME.text,
    });
  });
});
