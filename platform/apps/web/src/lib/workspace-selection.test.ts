import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorkspaceSelection, saveWorkspaceSelection } from "./workspace-selection.js";

const WS = "ws-650";
const MEMBER = "member-650";

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

describe("workspace selection persistence (#650)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to no restored channel when nothing is stored", () => {
    expect(loadWorkspaceSelection(WS, MEMBER)).toBeNull();
  });

  it("round-trips the selected channel per workspace and member", () => {
    saveWorkspaceSelection(WS, MEMBER, "c2");

    expect(loadWorkspaceSelection(WS, MEMBER)).toBe("c2");
    expect(loadWorkspaceSelection(WS, "other-member")).toBeNull();
    expect(loadWorkspaceSelection("other-workspace", MEMBER)).toBeNull();
  });

  it("ignores missing identifiers and unavailable writes", () => {
    expect(loadWorkspaceSelection(undefined, MEMBER)).toBeNull();
    expect(loadWorkspaceSelection(WS, null)).toBeNull();
    expect(() => saveWorkspaceSelection(WS, MEMBER, undefined)).not.toThrow();
    expect(localStorage.length).toBe(0);
  });

  it("survives storage that throws on read or write", () => {
    vi.stubGlobal("localStorage", {
      ...memoryStorage(),
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    });

    expect(loadWorkspaceSelection(WS, MEMBER)).toBeNull();
    expect(() => saveWorkspaceSelection(WS, MEMBER, "c2")).not.toThrow();
  });
});
