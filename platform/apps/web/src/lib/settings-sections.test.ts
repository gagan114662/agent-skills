import { describe, expect, it, vi } from "vitest";
import {
  SETTINGS_SECTION_ATTR,
  firstRunSettingsSection,
  scrollToSettingsSection,
} from "./settings-sections.js";

describe("settings deep-linking (#506)", () => {
  describe("firstRunSettingsSection — which section a checklist CTA lands on", () => {
    it("deep-links 'Set brand' to the Brand kit section, not the top of settings", () => {
      // The acceptance criterion: the brand step targets the brand section.
      expect(firstRunSettingsSection("brand")).toBe("brand");
    });

    it("deep-links 'Connect' to the Connect section", () => {
      expect(firstRunSettingsSection("connect")).toBe("connect");
    });

    it("returns null for steps with no settings surface", () => {
      // "run" and "approve" don't open settings — no deep-link target.
      expect(firstRunSettingsSection("run")).toBeNull();
      expect(firstRunSettingsSection("approve")).toBeNull();
    });
  });

  describe("scrollToSettingsSection — scrolls the targeted section into view", () => {
    function overlayWithSections(): HTMLElement {
      const root = document.createElement("div");
      for (const id of ["connect", "slack", "brand", "billing"]) {
        const section = document.createElement("section");
        section.setAttribute(SETTINGS_SECTION_ATTR, id);
        root.appendChild(section);
      }
      return root;
    }

    it("scrolls the brand section (not the first section) into view", () => {
      const root = overlayWithSections();
      const scroll = vi.fn();
      for (const el of Array.from(root.children)) {
        (el as HTMLElement).scrollIntoView = scroll;
      }
      const brand = root.querySelector(`[${SETTINGS_SECTION_ATTR}="brand"]`) as HTMLElement;

      expect(scrollToSettingsSection(root, "brand")).toBe(true);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.instances[0]).toBe(brand); // the brand section, not Connect at the top
    });

    it("is a safe no-op when the section or root is absent", () => {
      const root = overlayWithSections();
      expect(scrollToSettingsSection(root, null)).toBe(false);
      expect(scrollToSettingsSection(null, "brand")).toBe(false);
      // A section id with no matching element doesn't throw.
      const empty = document.createElement("div");
      expect(scrollToSettingsSection(empty, "brand")).toBe(false);
    });
  });
});
