import { describe, it, expect } from "vitest";
import { dedupeKey, normalizeText } from "../../src/memory/dedupe.js";

describe("memory dedupe key (issue #15)", () => {
  it("normalizes case and collapses whitespace", () => {
    expect(normalizeText("  We   Use\tPostgres\n")).toBe("we use postgres");
  });

  it("same statement differing only in case/whitespace yields the same key", () => {
    const a = dedupeKey("fact", "The API runs on port 3000");
    const b = dedupeKey("fact", "  the api   runs on PORT 3000  ");
    expect(a).toBe(b);
  });

  it("different type yields a different key (a decision is not the same node as a fact)", () => {
    expect(dedupeKey("decision", "use postgres")).not.toBe(dedupeKey("fact", "use postgres"));
  });

  it("different entity yields a different key", () => {
    expect(dedupeKey("fact", "ships daily", "deploy")).not.toBe(
      dedupeKey("fact", "ships daily", "auth"),
    );
  });

  it("is a stable 64-char hex digest", () => {
    expect(dedupeKey("fact", "hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});
