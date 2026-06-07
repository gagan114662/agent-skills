import { describe, it, expect } from "vitest";
import { rankRelevantContext, type ContextCandidate } from "../../src/memory/context.js";

/** Build a minimal candidate node. */
function node(id: string, opts: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    id,
    type: "fact",
    content: { text: id },
    entity: null,
    supersededByMemoryId: null,
    ...opts,
  };
}

describe("rankRelevantContext (pure)", () => {
  it("orders linked > neighbor > label-match and tags each reason", () => {
    const out = rankRelevantContext({
      linked: [node("a")],
      neighbors: [node("b")],
      labelMatches: [node("c")],
    });
    expect(out.map((e) => [e.id, e.reason])).toEqual([
      ["a", "linked"],
      ["b", "neighbor"],
      ["c", "label-match"],
    ]);
  });

  it("dedups by id, keeping the highest-priority occurrence", () => {
    const out = rankRelevantContext({
      linked: [node("a")],
      neighbors: [node("a"), node("b")], // 'a' repeats as a neighbor — drop the dup
      labelMatches: [node("b")], // 'b' repeats as a label-match — drop the dup
    });
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
    expect(out.find((e) => e.id === "a")!.reason).toBe("linked"); // kept the linked reason
    expect(out.find((e) => e.id === "b")!.reason).toBe("neighbor");
  });

  it("drops superseded (stale) nodes by default", () => {
    const out = rankRelevantContext({
      linked: [node("a"), node("stale", { supersededByMemoryId: "new" })],
      neighbors: [],
      labelMatches: [],
    });
    expect(out.map((e) => e.id)).toEqual(["a"]);
  });

  it("includes stale nodes when asked", () => {
    const out = rankRelevantContext(
      {
        linked: [node("a"), node("stale", { supersededByMemoryId: "new" })],
        neighbors: [],
        labelMatches: [],
      },
      { includeStale: true },
    );
    expect(out.map((e) => e.id)).toEqual(["a", "stale"]);
  });

  it("returns an empty list for empty buckets", () => {
    expect(rankRelevantContext({ linked: [], neighbors: [], labelMatches: [] })).toEqual([]);
  });
});
