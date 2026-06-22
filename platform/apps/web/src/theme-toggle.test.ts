/**
 * #729 user-facing theme toggle. Proves the runtime light ⇄ dark flip persists, reflects the live document
 * root, and restores a saved choice on boot — all over the SAME `data-theme="reload-dark"` attribute the
 * build-time gate (theme.ts) uses, so the two never disagree about what "dark" means.
 */
import { afterEach, describe, expect, it } from "vitest";
import { RELOAD_DARK_THEME } from "./theme.js";
import {
  applyStoredThemeMode,
  chooseThemeMode,
  currentThemeMode,
  setThemeMode,
  storedThemeMode,
  THEME_STORAGE_KEY,
  toggleThemeMode,
} from "./theme-toggle.js";

/** An in-memory Storage stub so the tests never touch the real localStorage. */
function memStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

afterEach(() => document.documentElement.removeAttribute("data-theme"));

describe("theme-toggle", () => {
  it("reads the live palette off the document root", () => {
    expect(currentThemeMode()).toBe("light");
    document.documentElement.setAttribute("data-theme", RELOAD_DARK_THEME);
    expect(currentThemeMode()).toBe("dark");
  });

  it("setThemeMode stamps/clears the gate's data-theme attribute without persisting", () => {
    const store = memStorage();
    setThemeMode("dark", document);
    expect(document.documentElement.getAttribute("data-theme")).toBe(RELOAD_DARK_THEME);
    expect(storedThemeMode(store)).toBeNull(); // not persisted
    setThemeMode("light", document);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("toggleThemeMode flips, persists, and returns the new mode", () => {
    const store = memStorage();
    expect(toggleThemeMode(document, store)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe(RELOAD_DARK_THEME);
    expect(store.getItem(THEME_STORAGE_KEY)).toBe("dark");

    expect(toggleThemeMode(document, store)).toBe("light");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(store.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("chooseThemeMode applies + persists an explicit choice", () => {
    const store = memStorage();
    chooseThemeMode("dark", document, store);
    expect(currentThemeMode()).toBe("dark");
    expect(storedThemeMode(store)).toBe("dark");
  });

  it("applyStoredThemeMode restores a saved override; ignores absent/garbage values", () => {
    applyStoredThemeMode(document, memStorage({ [THEME_STORAGE_KEY]: "dark" }));
    expect(currentThemeMode()).toBe("dark");

    document.documentElement.removeAttribute("data-theme");
    applyStoredThemeMode(document, memStorage({ [THEME_STORAGE_KEY]: "banana" }));
    expect(currentThemeMode()).toBe("light"); // garbage → gate default stands

    applyStoredThemeMode(document, memStorage()); // nothing saved → no-op
    expect(currentThemeMode()).toBe("light");
  });

  it("degrades to a no-op when storage throws (private mode / disabled)", () => {
    const hostile: Storage = {
      ...memStorage(),
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    // No throw, and the in-page flip still applied even though persistence failed.
    expect(() => chooseThemeMode("dark", document, hostile)).not.toThrow();
    expect(currentThemeMode()).toBe("dark");
    expect(storedThemeMode(hostile)).toBeNull();
  });
});
