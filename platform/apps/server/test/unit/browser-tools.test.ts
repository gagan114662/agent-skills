import { describe, it, expect } from "vitest";
import {
  BROWSER_TOOLS,
  BROWSER_TOOL_NAMES,
  browserToolSpec,
  consumesPage,
  isBrowserToolName,
  isSideEffectful,
} from "../../src/runtime/browser/tools.js";

describe("browser tool surface (#174)", () => {
  it("exposes exactly the seven scoped tools", () => {
    expect([...BROWSER_TOOL_NAMES]).toEqual([
      "navigate",
      "read_page",
      "screenshot",
      "scroll",
      "wait",
      "click",
      "type",
    ]);
    expect(BROWSER_TOOLS).toHaveLength(7);
  });

  it("classifies read-only browsing as free (not side-effectful)", () => {
    for (const name of ["navigate", "read_page", "screenshot", "scroll", "wait"] as const) {
      expect(isSideEffectful(name)).toBe(false);
    }
  });

  it("classifies remote-state mutations (click/type) as side-effectful — they get gated", () => {
    expect(isSideEffectful("click")).toBe(true);
    expect(isSideEffectful("type")).toBe(true);
  });

  it("only navigate consumes a page (counts against the page cap)", () => {
    expect(consumesPage("navigate")).toBe(true);
    for (const name of ["read_page", "screenshot", "scroll", "wait", "click", "type"] as const) {
      expect(consumesPage(name)).toBe(false);
    }
  });

  it("recognises valid tool names and rejects unknown ones", () => {
    expect(isBrowserToolName("click")).toBe(true);
    expect(isBrowserToolName("login")).toBe(false);
    expect(isBrowserToolName(42)).toBe(false);
    expect(() => browserToolSpec("login" as never)).toThrow(/unknown browser tool/);
  });

  it("every spec carries a human-readable description (the receipt vocabulary)", () => {
    for (const spec of BROWSER_TOOLS) {
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });
});
