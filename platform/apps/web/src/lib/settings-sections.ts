/**
 * Settings deep-linking (#506) — PURE so the deep-link target is unit-tested without the panels' network
 * wiring. The settings overlay stacks every section (Connect Claude, Slack, Connections, Agent Garden,
 * Brand kit, …), so a CTA that just "opens settings" lands at the very top. A CTA aimed at one section —
 * "Set brand" → Brand kit — must instead deep-link straight to it.
 *
 * Each panel in the overlay is tagged with `data-settings-section`; an opener passes the target id and the
 * overlay scrolls that section into view on open. Keeping the id list, the step → section map, and the
 * scroll behaviour here makes "where does Set brand land?" answerable in a test.
 */
import type { FirstRunStepKey } from "./firstrun-checklist.js";

/** The settings overlay's sections, in render order. The id a deep-link targets. */
export type SettingsSection =
  | "marketing"
  | "connect"
  | "slack"
  | "connections"
  | "garden"
  | "accounts"
  | "brand"
  | "billing";

/** DOM attribute each overlay section carries so a deep-link can find its target. */
export const SETTINGS_SECTION_ATTR = "data-settings-section";

/**
 * The settings section a first-run checklist step deep-links to, or null when the step has no settings
 * surface (e.g. "run" — the composer is already on screen). "brand" → the Brand kit section (#506).
 */
export function firstRunSettingsSection(key: FirstRunStepKey): SettingsSection | null {
  switch (key) {
    case "brand":
      return "brand";
    case "connect":
      return "connect";
    default:
      return null;
  }
}

/**
 * Scroll the deep-linked settings section into view within `root`. Returns whether a section was scrolled —
 * a no-op (false) when there's no target id or the section isn't in the DOM, so a missing section can never
 * throw. `scrollIntoView` is guarded for environments (jsdom) that don't implement it.
 */
export function scrollToSettingsSection(root: HTMLElement | null, section: SettingsSection | null): boolean {
  if (!root || !section) return false;
  const target = root.querySelector<HTMLElement>(`[${SETTINGS_SECTION_ATTR}="${section}"]`);
  if (!target) return false;
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "start" });
  }
  return true;
}
