/**
 * Brand-config tests (#122).
 *
 * Two guarantees:
 *  1. The deployed defaults describe **ipop**, never the internal "Reload" name.
 *  2. Product-chrome components contain NO hardcoded brand strings — they must read from `brand.ts`.
 *     This is the test that keeps a future edit from re-hardcoding "Reload" (or any brand) into the UI.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BRAND, applyBrand } from "./brand.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("brand defaults", () => {
  it("are ipop, not the internal platform name", () => {
    expect(BRAND.name).toBe("ipop");
    expect(BRAND.title).toMatch(/ipop/);
    // "Reload" is internal-only — it must never leak into any product-facing brand value.
    for (const value of Object.values(BRAND)) {
      expect(value.toLowerCase()).not.toContain("reload");
    }
  });

  it("expose every field product chrome needs", () => {
    for (const key of ["name", "mark", "title", "tagline", "accent"] as const) {
      expect(BRAND[key], `BRAND.${key}`).toBeTruthy();
    }
  });

  it("applyBrand stamps the document title and accent custom property", () => {
    applyBrand({ name: "Test", mark: "★", title: "Test Title", tagline: "t", accent: "#123456" });
    expect(document.title).toBe("Test Title");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  });
});

describe("no hardcoded brand strings in product chrome", () => {
  // Components that render the product shell. Every brand string here must come from BRAND.*.
  const CHROME_COMPONENTS = [
    "components/Workspace.tsx",
    "components/AuthGate.tsx",
    "components/ChannelSidebar.tsx",
  ];

  // Forbidden literals anywhere in chrome source: the internal name and the deployed brand name.
  // Comments are fine to mention "Reload" for context, so we only scan JSX/string content lines.
  for (const rel of CHROME_COMPONENTS) {
    it(`${rel} reads brand from brand.ts (no literal "Reload"/"ipop")`, () => {
      const src = readFileSync(resolve(HERE, rel), "utf8");
      const codeLines = src
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
        })
        .join("\n");
      expect(codeLines).not.toMatch(/Reload/);
      expect(codeLines).not.toMatch(/ipop/i);
      // It must actually import the brand config rather than inline its own copy.
      expect(src).toMatch(/from "\.\.\/brand\.js"/);
    });
  }
});
