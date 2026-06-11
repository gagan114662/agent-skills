import { describe, it, expect } from "vitest";
import { insightDedupeKey, isCited, suppressedByKill } from "../../src/insight/dedupe.js";
import { dedupeKey as memoryDedupeKey } from "../../src/memory/dedupe.js";

describe("insightDedupeKey", () => {
  it("normalizes case/whitespace so the same statement → one key (reuses the #15 memory key)", () => {
    expect(insightDedupeKey("Founders hate manual invoicing")).toBe(
      insightDedupeKey("  founders   HATE manual invoicing  "),
    );
  });

  it("matches the #15 memory graph key for the same statement (so KILLs resolve to one node)", () => {
    const statement = "Indie devs abandon CI tools over flaky caches";
    expect(insightDedupeKey(statement)).toBe(memoryDedupeKey("insight", statement, null));
  });
});

describe("isCited", () => {
  it("is true when at least one evidence row has a non-empty source URL", () => {
    expect(
      isCited([
        { sourceUrl: null, excerpt: "x", observedAt: new Date(), sourceId: null },
        { sourceUrl: "https://forum.example/123", excerpt: "y", observedAt: new Date(), sourceId: null },
      ]),
    ).toBe(true);
  });

  it("is false when there is no evidence or every URL is empty/blank", () => {
    expect(isCited([])).toBe(false);
    expect(
      isCited([{ sourceUrl: "   ", excerpt: "y", observedAt: new Date(), sourceId: null }]),
    ).toBe(false);
  });
});

describe("suppressedByKill (killed angles never return UNCITED)", () => {
  const key = insightDedupeKey("rebuild the X");
  const killed = new Set([key]);

  it("suppresses a killed angle that is uncited", () => {
    expect(suppressedByKill({ dedupeKey: key, killedKeys: killed, cited: false })).toBe(true);
  });

  it("does NOT suppress a killed angle that now carries a real citation (new evidence reopens it)", () => {
    expect(suppressedByKill({ dedupeKey: key, killedKeys: killed, cited: true })).toBe(false);
  });

  it("does NOT suppress an angle that was never killed", () => {
    expect(
      suppressedByKill({ dedupeKey: insightDedupeKey("a fresh angle"), killedKeys: killed, cited: false }),
    ).toBe(false);
  });

  it("accepts an array of killed keys as well as a Set", () => {
    expect(suppressedByKill({ dedupeKey: key, killedKeys: [key], cited: false })).toBe(true);
  });
});
