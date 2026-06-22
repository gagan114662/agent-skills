/**
 * Acceptance test for issue #593 — "Per-agent performance scorecard tied to conversions".
 *
 * The literal acceptance criteria from the issue:
 *   1. attribute pipeline + revenue to the ORIGINATING agent and channel;
 *   2. updated as conversions land;
 *   3. the user can RANK agents by revenue / pipeline influenced.
 *
 * These tests drive the public barrel exactly as the fleet would — sync a realistic conversion feed, read back a
 * ranked scorecard — and assert each criterion directly.
 */

import { describe, it, expect } from "vitest";
import {
  ScorecardService,
  InMemoryScorecardStore,
  StaticConversionSource,
  buildScorecard,
  type ConversionFeed,
  type ScorecardCaps,
} from "../../src/agent-scorecard/index.js";

const ENABLED: ScorecardCaps = { enabled: true, ownerWorkspaceOnly: false, ownerWorkspaceId: null, pipelineWeight: 0.3 };
const WID = "ws-acceptance";
const T = (d: number) => new Date(Date.UTC(2026, 2, d));

/** A realistic fleet: a closer who books revenue, a builder who fills pipeline, and a quiet agent. */
const FEED: ConversionFeed = {
  events: [
    { eventId: "c1", agentId: "closer", channel: "email", kind: "revenue", amountUsd: 60_000, customerId: "acme", occurredAt: T(1) },
    { eventId: "c2", agentId: "closer", channel: "ads", kind: "revenue", amountUsd: 20_000, customerId: "globex", occurredAt: T(2) },
    { eventId: "p1", agentId: "builder", channel: "social", kind: "pipeline", amountUsd: 120_000, customerId: "initech", occurredAt: T(3) },
    { eventId: "c3", agentId: "builder", channel: "social", kind: "revenue", amountUsd: 15_000, customerId: "initech", occurredAt: T(4) },
    { eventId: "p2", agentId: "quiet", channel: "organic", kind: "pipeline", amountUsd: 5_000, occurredAt: T(5) },
  ],
  activities: [
    { agentId: "closer", channel: "email", touches: 80 },
    { agentId: "closer", channel: "ads", touches: 40 },
    { agentId: "builder", channel: "social", touches: 60 },
    { agentId: "quiet", channel: "organic", touches: 10 },
  ],
};

function service(store = new InMemoryScorecardStore()) {
  return new ScorecardService({ store, source: new StaticConversionSource(FEED), caps: ENABLED });
}

describe("#593 acceptance", () => {
  it("attributes pipeline + revenue to the originating agent AND channel", async () => {
    const s = service();
    await s.sync(WID);
    const { agents } = await s.getScorecard(WID);

    const closer = agents.find((a) => a.agentId === "closer")!;
    expect(closer.revenueUsd).toBe(80_000);
    expect(closer.pipelineUsd).toBe(0);
    // channel-level attribution is present
    expect(closer.channels.find((c) => c.channel === "email")!.revenueUsd).toBe(60_000);
    expect(closer.channels.find((c) => c.channel === "ads")!.revenueUsd).toBe(20_000);
    expect(closer.topChannel).toBe("email");

    const builder = agents.find((a) => a.agentId === "builder")!;
    expect(builder.revenueUsd).toBe(15_000);
    expect(builder.pipelineUsd).toBe(120_000);
  });

  it("lets the user rank agents by revenue/pipeline influenced", async () => {
    const s = service();
    await s.sync(WID);

    // default: by blended influence — closer (80k) beats builder (15k + 0.3*120k = 51k) beats quiet
    const influence = await s.getScorecard(WID);
    expect(influence.agents.map((a) => a.agentId)).toEqual(["closer", "builder", "quiet"]);
    expect(influence.agents[0]!.score).toBe(100); // leader normalized to 100

    // by realized revenue: closer (80k) still leads, builder (15k) second
    const byRevenue = await s.getScorecard(WID, { rankBy: "revenue" });
    expect(byRevenue.agents.map((a) => a.agentId)).toEqual(["closer", "builder", "quiet"]);

    // by pipeline: builder (120k) leads, quiet (5k) second, closer (0) last
    const byPipeline = await s.getScorecard(WID, { rankBy: "pipeline" });
    expect(byPipeline.agents.map((a) => a.agentId)).toEqual(["builder", "quiet", "closer"]);
  });

  it("updates as conversions land (idempotent re-sync, accumulates new events)", async () => {
    const store = new InMemoryScorecardStore();
    const s = service(store);
    await s.sync(WID);
    const before = await s.getScorecard(WID);
    const closerBefore = before.agents.find((a) => a.agentId === "closer")!.revenueUsd;

    // a fresh conversion lands for the closer
    const grew: ConversionFeed = {
      events: [
        ...FEED.events,
        { eventId: "c4", agentId: "closer", channel: "email", kind: "revenue", amountUsd: 25_000, customerId: "newco", occurredAt: T(6) },
      ],
      activities: FEED.activities,
    };
    const s2 = new ScorecardService({ store, source: new StaticConversionSource(grew), caps: ENABLED });
    const result = await s2.sync(WID);
    expect(result.eventsIngested).toBe(1); // only the new conversion

    const after = await s2.getScorecard(WID);
    expect(after.agents.find((a) => a.agentId === "closer")!.revenueUsd).toBe(closerBefore + 25_000);
  });

  it("the pure core reproduces the service's ranking from the same data (no IO)", async () => {
    const direct = buildScorecard(FEED, { pipelineWeight: 0.3 });
    const s = service();
    await s.sync(WID);
    const viaService = await s.getScorecard(WID);
    expect(viaService.agents.map((a) => a.agentId)).toEqual(direct.agents.map((a) => a.agentId));
  });
});
