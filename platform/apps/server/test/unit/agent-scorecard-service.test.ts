/**
 * Unit tests for the scorecard service (#593) over the in-memory store + a static source. Exercises default-OFF
 * gating, owner-workspace-first scope, sync idempotency ("updated as conversions land"), activity-replace
 * semantics, ranking override, and workspace (IDOR) scoping.
 */

import { describe, it, expect } from "vitest";
import { ScorecardService, ScorecardError } from "../../src/agent-scorecard/service.js";
import { InMemoryScorecardStore } from "../../src/agent-scorecard/store.js";
import { StaticConversionSource, type ConversionFeed } from "../../src/agent-scorecard/source.js";
import { SCORECARD_DEFAULTS, type ScorecardCaps } from "../../src/agent-scorecard/caps.js";
import type { ConversionEvent } from "../../src/agent-scorecard/types.js";

const WID = "ws-1";
const OTHER = "ws-2";
const ENABLED: ScorecardCaps = { enabled: true, ownerWorkspaceOnly: false, ownerWorkspaceId: null, pipelineWeight: 0.3 };

const T = new Date("2026-03-01T00:00:00.000Z");
function rev(eventId: string, agentId: string, amountUsd: number): ConversionEvent {
  return { eventId, agentId, channel: "email", kind: "revenue", amountUsd, occurredAt: T };
}

function svc(opts: { caps?: ScorecardCaps; feed?: ConversionFeed; store?: InMemoryScorecardStore } = {}) {
  const feed: ConversionFeed = opts.feed ?? {
    events: [rev("e1", "alpha", 30_000), rev("e2", "beta", 10_000)],
    activities: [{ agentId: "alpha", channel: "email", touches: 40 }],
  };
  return new ScorecardService({
    store: opts.store ?? new InMemoryScorecardStore(),
    source: new StaticConversionSource(feed),
    caps: opts.caps ?? ENABLED,
  });
}

describe("default-OFF gating", () => {
  it("is disabled by env defaults and refuses sync + read", async () => {
    expect(SCORECARD_DEFAULTS.enabled).toBe(false);
    const s = svc({ caps: SCORECARD_DEFAULTS });
    expect(s.isEnabledFor(WID)).toBe(false);
    await expect(s.sync(WID)).rejects.toBeInstanceOf(ScorecardError);
    await expect(s.getScorecard(WID)).rejects.toBeInstanceOf(ScorecardError);
  });

  it("owner-workspace-first: only the owner workspace is in scope", async () => {
    const caps: ScorecardCaps = { enabled: true, ownerWorkspaceOnly: true, ownerWorkspaceId: WID, pipelineWeight: 0.3 };
    const s = svc({ caps });
    expect(s.isEnabledFor(WID)).toBe(true);
    expect(s.isEnabledFor(OTHER)).toBe(false);
    await expect(s.sync(OTHER)).rejects.toBeInstanceOf(ScorecardError);
  });
});

describe("sync (updated as conversions land)", () => {
  it("ingests events + activity, then surfaces them in the scorecard", async () => {
    const s = svc();
    const result = await s.sync(WID);
    expect(result.eventsIngested).toBe(2);
    expect(result.activitiesIngested).toBe(1);
    expect(result.source).toBe("static");

    const { agents, totals } = await s.getScorecard(WID);
    expect(agents.map((a) => a.agentId)).toEqual(["alpha", "beta"]);
    expect(totals.revenueUsd).toBe(40_000);
  });

  it("is idempotent — re-syncing the same feed ingests no new events", async () => {
    const s = svc();
    await s.sync(WID);
    const second = await s.sync(WID);
    expect(second.eventsIngested).toBe(0);
    const { totals } = await s.getScorecard(WID);
    expect(totals.revenueUsd).toBe(40_000); // not double-counted
  });

  it("accumulates NEW events landing in a later feed", async () => {
    const store = new InMemoryScorecardStore();
    const first = svc({
      store,
      feed: { events: [rev("e1", "alpha", 30_000)], activities: [] },
    });
    await first.sync(WID);

    // a later sync from a source that has a new conversion
    const later = svc({
      store,
      feed: { events: [rev("e1", "alpha", 30_000), rev("e2", "alpha", 20_000)], activities: [] },
    });
    const result = await later.sync(WID);
    expect(result.eventsIngested).toBe(1); // only e2 is new
    const { agents } = await later.getScorecard(WID);
    expect(agents[0]!.revenueUsd).toBe(50_000);
  });

  it("replaces the activity snapshot on each sync (current-state, not a ledger)", async () => {
    const store = new InMemoryScorecardStore();
    const a = svc({ store, feed: { events: [], activities: [{ agentId: "x", channel: "email", touches: 10 }] } });
    await a.sync(WID);
    const b = svc({ store, feed: { events: [], activities: [{ agentId: "x", channel: "email", touches: 99 }] } });
    await b.sync(WID);
    const { agents } = await b.getScorecard(WID);
    expect(agents[0]!.touches).toBe(99); // replaced, not summed to 109
  });
});

describe("ranking override", () => {
  it("ranks by revenue when asked, ignoring pipeline", async () => {
    const feed: ConversionFeed = {
      events: [
        { eventId: "e1", agentId: "closer", channel: "email", kind: "revenue", amountUsd: 50_000, occurredAt: T },
        { eventId: "e2", agentId: "builder", channel: "email", kind: "pipeline", amountUsd: 999_000, occurredAt: T },
      ],
      activities: [],
    };
    const s = svc({ feed });
    await s.sync(WID);
    const byRevenue = await s.getScorecard(WID, { rankBy: "revenue" });
    expect(byRevenue.agents[0]!.agentId).toBe("closer");
  });
});

describe("workspace (IDOR) scoping", () => {
  it("never leaks one workspace's conversions into another", async () => {
    const store = new InMemoryScorecardStore();
    const s = svc({ store, caps: ENABLED });
    await s.sync(WID);
    const other = await s.getScorecard(OTHER);
    expect(other.agents).toEqual([]);
    expect(other.totals.conversions).toBe(0);
  });
});
