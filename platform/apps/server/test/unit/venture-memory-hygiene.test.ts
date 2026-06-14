import { describe, it, expect } from "vitest";
import { dedupeEntries, reviewStaleness } from "../../src/venture-memory/hygiene.js";
import type { VentureMemoryEntry } from "../../src/venture-memory/types.js";

const DAY = 86_400_000;

function e(over: Partial<VentureMemoryEntry> = {}): VentureMemoryEntry {
  return {
    id: "m",
    ideaId: "idea_1",
    kind: "worked",
    text: "cold email worked",
    why: null,
    sourceRef: null,
    createdAtMs: 0,
    stale: false,
    ...over,
  };
}

describe("reviewStaleness: fresh / superseded / needs-review", () => {
  const now = 100 * DAY;

  it("a superseded entry is never fresh", () => {
    const r = reviewStaleness([e({ id: "s", stale: true, createdAtMs: now })], now, 45);
    expect(r.superseded.map((x) => x.id)).toEqual(["s"]);
    expect(r.fresh).toEqual([]);
  });

  it("a non-superseded aged entry is surfaced for review", () => {
    const r = reviewStaleness([e({ id: "old", createdAtMs: now - 60 * DAY })], now, 45);
    expect(r.needsReview.map((x) => x.id)).toEqual(["old"]);
  });

  it("an in-window entry is fresh", () => {
    const r = reviewStaleness([e({ id: "new", createdAtMs: now - 10 * DAY })], now, 45);
    expect(r.fresh.map((x) => x.id)).toEqual(["new"]);
  });

  it("staleAfterDays=0 disables the review window", () => {
    const r = reviewStaleness([e({ id: "old", createdAtMs: 0 })], now, 0);
    expect(r.needsReview).toEqual([]);
    expect(r.fresh.map((x) => x.id)).toEqual(["old"]);
  });
});

describe("dedupeEntries: collapse same-kind restatements, keep first", () => {
  it("keeps the first occurrence of a (kind, statement)", () => {
    const out = dedupeEntries([
      e({ id: "newest", text: "Cold email worked!" }),
      e({ id: "older", text: "cold email worked" }),
      e({ id: "diff", kind: "failed", text: "cold email worked" }),
    ]);
    expect(out.map((x) => x.id)).toEqual(["newest", "diff"]);
  });
});
