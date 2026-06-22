import { describe, it, expect } from "vitest";
import { InMemoryFunnelEventStore } from "../../src/analytics/funnel/store.js";
import { FunnelService } from "../../src/analytics/funnel/service.js";

/** A service over a fresh in-memory store with a controllable clock. */
function build(now = () => 1_700_000_000_000) {
  const store = new InMemoryFunnelEventStore();
  return { store, svc: new FunnelService({ store, now }) };
}

describe("FunnelService.track (the shared ingest seam)", () => {
  it("records a normalized event and surfaces it in the view, workspace-scoped", async () => {
    const { svc } = build();
    await svc.track("w-1", { stage: "visit", channel: "organic", agent: "scout" });
    await svc.track("w-1", { stage: "signup", channel: "organic", agent: "scout" });
    await svc.track("w-2", { stage: "visit" }); // a different workspace must not bleed in

    const view = await svc.view("w-1");
    expect(view.counts).toEqual({ visit: 1, signup: 1, activation: 0, paid: 0 });
    expect(view.rates.signupRate).toBe(1);
    expect(view.byChannel.map((r) => r.key)).toEqual(["organic"]);
    expect(view.eventCount).toBe(2);
  });

  it("returns the normalized event so a caller can echo it back", async () => {
    const { svc } = build();
    const e = await svc.track("w-1", { stage: "paid", surface: "product", value: 2 });
    expect(e.stage).toBe("paid");
    expect(e.surface).toBe("product");
    expect(e.value).toBe(2);
    expect(e.channel).toBe("direct");
  });

  it("rejects an invalid event without recording anything", async () => {
    const { svc } = build();
    await expect(svc.track("w-1", { stage: "purchase" })).rejects.toThrow(/stage/);
    const view = await svc.view("w-1");
    expect(view.eventCount).toBe(0);
  });
});

describe("FunnelService.view (the one funnel view)", () => {
  it("is an empty all-zero view for a workspace with no events", async () => {
    const { svc } = build();
    const view = await svc.view("w-empty");
    expect(view.counts).toEqual({ visit: 0, signup: 0, activation: 0, paid: 0 });
    expect(view.byChannel).toEqual([]);
    expect(view.byAgent).toEqual([]);
  });

  it("honours a trailing window, dropping events older than windowDays", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const { svc } = build(() => now);

    // An old visit (40 days ago) and a recent one (1 day ago).
    await svc.track("w-1", { stage: "visit", occurredAtMs: (100 - 40) * day });
    await svc.track("w-1", { stage: "visit", occurredAtMs: (100 - 1) * day });

    const last7 = await svc.view("w-1", 7);
    expect(last7.counts.visit).toBe(1); // only the recent one is inside the 7-day window

    const all = await svc.view("w-1"); // no window ⇒ everything
    expect(all.counts.visit).toBe(2);
  });
});
