/**
 * App-wide dark theme (#378) — the single reload.chat black look, applied via a `data-theme` attribute on
 * the document root so the whole app (login + marketing landing + console) flips to dark by overriding the
 * brand colour tokens in `styles.css` (`:root[data-theme="reload-dark"]`). Nothing else changes.
 *
 * GATED exactly like the coordination surface (#352): keyed off the BUILD-TIME `COORDINATION_UI_ENABLED`
 * flag (`VITE_RELOAD_COORDINATION_UI`). Production sets no such env ⇒ the flag is off ⇒ no attribute is set
 * ⇒ the default paper palette renders byte-for-byte today's app. The owner enables it on their own
 * deployment/preview, where the chat-first surface also turns on. Reversible: unset the env, the dark look
 * is gone. The light app never imports a single new token — it just lacks the override.
 *
 * The theme is deployment-scoped (not per-workspace) ON PURPOSE: login + landing render before any
 * workspace is known, so a per-workspace gate could not theme them. The owner-workspace gate still governs
 * the coordination *surface*; this only governs the *palette* of the owner's deployment.
 */
import { COORDINATION_UI_ENABLED } from "./components/console/coordination-flag.js";

/** The single dark theme name (the `data-theme` value + the styles.css override selector). */
export const RELOAD_DARK_THEME = "reload-dark";

/** The theme name to apply, or null to keep the default light palette. Pure, so it is unit-tested directly. */
export function reloadThemeName(flagOn: boolean = COORDINATION_UI_ENABLED): string | null {
  return flagOn ? RELOAD_DARK_THEME : null;
}

/**
 * Stamp (or clear) the `data-theme` attribute on the document root before first paint. Called once from
 * `main.tsx`. With the flag off it actively REMOVES the attribute, so the app can never get stuck dark.
 */
export function applyReloadTheme(
  flagOn: boolean = COORDINATION_UI_ENABLED,
  doc: Document = document,
): void {
  const name = reloadThemeName(flagOn);
  if (name) doc.documentElement.setAttribute("data-theme", name);
  else doc.documentElement.removeAttribute("data-theme");
}
