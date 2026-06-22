/**
 * Unit tests for the conversion data-source seam (#593): the FAKE source is deterministic, offline, and
 * well-formed; the static source echoes its seeded feed.
 */

import { describe, it, expect } from "vitest";
import {
  FakeConversionSource,
  StaticConversionSource,
  type ConversionFeed,
} from "../../src/agent-scorecard/source.js";
import { buildScorecard } from "../../src/agent-scorecard/score.js";

describe("FakeConversionSource", () => {
  it("is marked offline (never makes external calls)", () => {
    const src = new FakeConversionSource();
    expect(src.name).toBe("fake");
    expect(src.live).toBe(false);
  });

  it("is deterministic — same workspace yields an identical feed every call", async () => {
    const src = new FakeConversionSource();
    const a = await src.fetch("ws-1");
    const b = await src.fetch("ws-1");
    expect(a).toEqual(b);
  });

  it("varies by workspace but is internally well-formed", async () => {
    const src = new FakeConversionSource();
    const ws1 = await src.fetch("ws-1");
    const ws2 = await src.fetch("ws-2");
    expect(ws1).not.toEqual(ws2);

    for (const feed of [ws1, ws2]) {
      // unique event ids, non-negative amounts, known kinds, real dates
      const ids = feed.events.map((e) => e.eventId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const e of feed.events) {
        expect(e.amountUsd).toBeGreaterThanOrEqual(0);
        expect(["revenue", "pipeline"]).toContain(e.kind);
        expect(e.occurredAt).toBeInstanceOf(Date);
        expect(Number.isNaN(e.occurredAt.getTime())).toBe(false);
      }
      expect(feed.activities.length).toBeGreaterThan(0);
    }
  });

  it("feeds the pure core into a non-empty ranked scorecard", async () => {
    const feed = await new FakeConversionSource().fetch("ws-demo");
    const { agents } = buildScorecard(feed);
    expect(agents.length).toBeGreaterThan(0);
    // ranks are dense and ordered
    expect(agents.map((a) => a.rank)).toEqual(agents.map((_, i) => i + 1));
  });
});

describe("StaticConversionSource", () => {
  it("returns a defensive copy of its seeded feed", async () => {
    const feed: ConversionFeed = {
      events: [{ eventId: "e1", agentId: "a", channel: "email", kind: "revenue", amountUsd: 100, occurredAt: new Date(0) }],
      activities: [{ agentId: "a", channel: "email", touches: 5 }],
    };
    const src = new StaticConversionSource(feed);
    const out = await src.fetch("any");
    expect(out).toEqual(feed);
    // mutating the returned feed must not corrupt the source
    out.events[0]!.amountUsd = 999;
    const again = await src.fetch("any");
    expect(again.events[0]!.amountUsd).toBe(100);
  });
});
