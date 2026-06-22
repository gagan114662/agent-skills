/**
 * #729 user-facing theme toggle. The build-time gate ({@link applyReloadTheme} in theme.ts) picks the
 * deployment's DEFAULT palette; this lets a person flip light ⇄ dark at runtime from the command dock and
 * remembers the choice per browser. It only ever toggles the SAME `data-theme="reload-dark"` attribute and
 * palette the gate uses (no new tokens), so a light deployment gains dark and a dark deployment gains light.
 *
 * Pure + dependency-injected (doc + storage) so it is unit-tested directly and is SSR-safe: nothing runs at
 * import time, and every storage access is guarded (private-mode / disabled storage degrades to no-op).
 */
import { RELOAD_DARK_THEME } from "./theme.js";

export type ThemeMode = "light" | "dark";

/** localStorage key holding the user's explicit override ("light" | "dark"), if any. */
export const THEME_STORAGE_KEY = "reload-theme";

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** The palette currently showing — read straight from the document root the gate/toggle both write. */
export function currentThemeMode(doc: Document = document): ThemeMode {
  return doc.documentElement.getAttribute("data-theme") === RELOAD_DARK_THEME ? "dark" : "light";
}

/** Apply a palette to the document root WITHOUT persisting (used by tests + boot). */
export function setThemeMode(mode: ThemeMode, doc: Document = document): void {
  if (mode === "dark") doc.documentElement.setAttribute("data-theme", RELOAD_DARK_THEME);
  else doc.documentElement.removeAttribute("data-theme");
}

/** The saved user override, or null when the user has never toggled (gate default stands). */
export function storedThemeMode(storage: Storage | null = safeStorage()): ThemeMode | null {
  try {
    const v = storage?.getItem(THEME_STORAGE_KEY) ?? null;
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

/** Apply + persist an explicit user choice. */
export function chooseThemeMode(
  mode: ThemeMode,
  doc: Document = document,
  storage: Storage | null = safeStorage(),
): void {
  setThemeMode(mode, doc);
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* private mode / disabled storage — the in-page flip still applied, it just won't persist. */
  }
}

/** Flip the palette, persist it, and return the new mode. */
export function toggleThemeMode(
  doc: Document = document,
  storage: Storage | null = safeStorage(),
): ThemeMode {
  const next: ThemeMode = currentThemeMode(doc) === "dark" ? "light" : "dark";
  chooseThemeMode(next, doc, storage);
  return next;
}

/**
 * Apply a saved user preference over the gate default. Called once from main.tsx AFTER applyReloadTheme so
 * a reload restores the user's last choice with no flash. A no-op when the user has never toggled.
 */
export function applyStoredThemeMode(
  doc: Document = document,
  storage: Storage | null = safeStorage(),
): void {
  const saved = storedThemeMode(storage);
  if (saved) setThemeMode(saved, doc);
}
