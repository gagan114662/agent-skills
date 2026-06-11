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
import {
  BRAND,
  VOICE,
  DEPARTMENT_SPECTRUM,
  departmentColor,
  applyBrand,
  FLEET,
  agentColor,
  LANDING,
} from "./brand.js";

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

describe("pop identity (#138)", () => {
  it("uses Pop Vermilion as the accent", () => {
    expect(BRAND.accent.toLowerCase()).toBe("#ff4524");
  });

  it("carries the Innocent-school house voice with the sign-off", () => {
    expect(VOICE.signOff).toBe("made by robots, steered by humans.");
    for (const key of ["loading", "emptyChannel", "noMessages", "offlineTitle", "offlineBody"] as const) {
      expect(VOICE[key], `VOICE.${key}`).toBeTruthy();
    }
  });

  it("maps the seven marketing departments to a spectrum, keyed by channel name", () => {
    expect(Object.keys(DEPARTMENT_SPECTRUM).sort()).toEqual([
      "ads",
      "analytics",
      "brand",
      "content",
      "email",
      "seo",
      "social",
    ]);
    expect(departmentColor("seo")).toBe("#ff4524");
    expect(departmentColor("brand")).toBe("#b07bff");
    expect(departmentColor("general")).toBeUndefined(); // shared rooms have no department hue
    expect(departmentColor(null)).toBeUndefined();
  });

  it("the stylesheet :root carries the Paper/Ink/Vermilion palette", () => {
    const css = readFileSync(resolve(HERE, "styles.css"), "utf8");
    expect(css).toMatch(/--paper:\s*#f6f1e7/i);
    expect(css).toMatch(/--ink:\s*#171310/i);
    expect(css).toMatch(/--vermilion:\s*#ff4524/i);
    // The playful motion curve from the brand book.
    expect(css).toMatch(/cubic-bezier\(0\.2,\s*1\.4,\s*0\.3,\s*1\)/);
    // Motion respects reduced-motion.
    expect(css).toMatch(/prefers-reduced-motion/);
  });
});

describe("landing fleet + copy (#149)", () => {
  it("names the seven marketing specialists, each tied to a real department hue", () => {
    expect(FLEET).toHaveLength(7);
    const handles = FLEET.map((a) => a.handle);
    expect(new Set(handles).size).toBe(7); // no duplicates
    for (const agent of FLEET) {
      expect(agent.name, agent.handle).toBeTruthy();
      expect(agent.personality, agent.handle).toBeTruthy();
      // Every agent's department keys the spectrum, and agentColor resolves to that hue.
      expect(DEPARTMENT_SPECTRUM[agent.department], agent.handle).toBeTruthy();
      expect(agentColor(agent)).toBe(departmentColor(agent.department));
    }
  });

  it("covers all seven departments exactly once", () => {
    expect(FLEET.map((a) => a.department).sort()).toEqual(Object.keys(DEPARTMENT_SPECTRUM).sort());
  });

  it("carries hero copy, three how-it-works steps, and a pricing teaser of three plans", () => {
    expect(LANDING.hero.ctaPrimary).toBeTruthy();
    expect(LANDING.hero.ctaSecondary).toBeTruthy();
    expect(LANDING.steps).toHaveLength(3);
    expect(LANDING.plans).toHaveLength(3);
    expect(LANDING.plans.filter((p) => p.featured)).toHaveLength(1); // one recommended tier
  });

  it("scripts a vignette that ends on a completed task (the confetti beat)", () => {
    expect(LANDING.vignette.length).toBeGreaterThan(2);
    expect(LANDING.vignette.some((line) => line.done)).toBe(true);
    // Every agent line references a real fleet handle (so the bubble can wear its colour).
    const handles = new Set(FLEET.map((a) => a.handle));
    for (const line of LANDING.vignette) {
      if (line.from !== "you") expect(handles.has(line.from), line.from).toBe(true);
    }
  });
});

describe("no hardcoded brand strings in product chrome", () => {
  // Components that render the product shell. Every brand string here must come from BRAND.*.
  const CHROME_COMPONENTS = [
    "components/Workspace.tsx",
    "components/AuthGate.tsx",
    "components/ChannelSidebar.tsx",
    // The public landing (#149) is the most brand-heavy surface — every word must come from brand.ts.
    "components/landing/Landing.tsx",
    "components/landing/HeroVignette.tsx",
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
      // It must actually import the brand config rather than inline its own copy (any nesting depth).
      expect(src).toMatch(/from "(?:\.\.\/)+brand\.js"/);
    });
  }
});
