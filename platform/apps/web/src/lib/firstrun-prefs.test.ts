import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadFirstRunPrefs, saveFirstRunPrefs } from "./firstrun-prefs.js";

const WS = "ws-505";

/** A minimal in-memory Storage so the helper is tested independently of jsdom's storage quirks. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

describe("firstrun-prefs (#505): per-user dismissed/docked persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to not-dismissed, not-collapsed when nothing is stored", () => {
    expect(loadFirstRunPrefs(WS)).toEqual({ dismissed: false, collapsed: false });
  });

  it("round-trips a saved dismissal so it sticks across reloads", () => {
    saveFirstRunPrefs(WS, { dismissed: true, collapsed: false });
    expect(loadFirstRunPrefs(WS)).toEqual({ dismissed: true, collapsed: false });
  });

  it("round-trips a docked (collapsed) state", () => {
    saveFirstRunPrefs(WS, { dismissed: false, collapsed: true });
    expect(loadFirstRunPrefs(WS)).toEqual({ dismissed: false, collapsed: true });
  });

  it("scopes prefs per workspace — one user's dismissal doesn't affect another", () => {
    saveFirstRunPrefs(WS, { dismissed: true, collapsed: true });
    expect(loadFirstRunPrefs("other-ws")).toEqual({ dismissed: false, collapsed: false });
  });

  it("ignores a missing workspace id (reads and writes are no-ops, never throw)", () => {
    expect(loadFirstRunPrefs(undefined)).toEqual({ dismissed: false, collapsed: false });
    expect(loadFirstRunPrefs(null)).toEqual({ dismissed: false, collapsed: false });
    expect(() => saveFirstRunPrefs(undefined, { dismissed: true, collapsed: true })).not.toThrow();
    expect(localStorage.length).toBe(0);
  });

  it("falls back to defaults on malformed stored JSON instead of throwing", () => {
    localStorage.setItem(`reload.firstrun.${WS}`, "{not json");
    expect(loadFirstRunPrefs(WS)).toEqual({ dismissed: false, collapsed: false });
  });

  it("coerces non-boolean stored values to safe defaults", () => {
    localStorage.setItem(`reload.firstrun.${WS}`, JSON.stringify({ dismissed: "yes", collapsed: 1 }));
    expect(loadFirstRunPrefs(WS)).toEqual({ dismissed: false, collapsed: false });
  });

  it("survives storage that throws on write (blocked/full) without breaking", () => {
    vi.stubGlobal("localStorage", {
      ...memoryStorage(),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => saveFirstRunPrefs(WS, { dismissed: true, collapsed: false })).not.toThrow();
  });
});
