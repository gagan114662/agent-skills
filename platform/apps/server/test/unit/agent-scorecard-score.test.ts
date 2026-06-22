/**
 * Unit tests for the per-agent scorecard pure core (#593). Drives `buildScorecard` with known events + activity
 * and asserts attribution, the influence blend + cohort-normalized score, per-channel breakdown, conversion rate,
 * deterministic ranking + ties, and the defensive handling of blank/negative/empty input.
 */

import { describe, it, expect } from "vitest";
import {
  buildScorecard,
  DEFAULT_PIPELINE_WEIGHT,
  type ScorecardInput,
} from "../../src/agent-scorecard/score.js";
import type { AgentActivity, ConversionEvent } from "../../src/agent-scorecard/types.js";

const T = new Date("2026-03-01T00:00:00.000Z");

function rev(eventId: string, agentId: string, channel: string, amountUsd: number, customerId?: string): ConversionEvent {
  return customerId === undefined
    ? { eventId, agentId, channel, kind: "revenue", amountUsd, occurredAt: T }
    : { eventId, agentId, channel, kind: "revenue", amountUsd, customerId, occurredAt: T };
}
function pipe(eventId: string, agentId: string, channel: string, amountUsd: number, customerId?: string): ConversionEvent {
  return customerId === undefined
    ? { eventId, agentId, channel, kind: "pipeline", amountUsd, occurredAt: T }
    : { eventId, agentId, channel, kind: "pipeline", amountUsd, customerId, occurredAt: T };
}
function act(agentId: string, channel: string, touches: number): AgentActivity {
  return { agentId, channel, touches };
}

describe("attribution", () => {
  it("sums revenue and pipeline per agent and splits the kinds", () => {
    const input: ScorecardInput = {
      events: [
        rev("e1", "scout", "email", 10_000, "c1"),
        rev("e2", "scout", "email", 5_000, "c2"),
        pipe("e3", "scout", "ads", 20_000, "c3"),
      ],
      activities: [],
    };
    const { agents } = buildScorecard(input);
    expect(agents).toHaveLength(1);
    const scout = agents[0]!;
    expect(scout.revenueUsd).toBe(15_000);
    expect(scout.pipelineUsd).toBe(20_000);
    expect(scout.conversions).toBe(3);
    expect(scout.revenueConversions).toBe(2);
    expect(scout.influencedCustomers).toBe(3);
  });

  it("blends influence as revenue + pipelineWeight × pipeline (default 0.3)", () => {
    const { agents } = buildScorecard({
      events: [rev("e1", "a", "email", 100_000), pipe("e2", "a", "email", 100_000)],
      activities: [],
    });
    expect(DEFAULT_PIPELINE_WEIGHT).toBe(0.3);
    expect(agents[0]!.influenceUsd).toBe(130_000); // 100k + 0.3*100k
  });

  it("honors a custom pipelineWeight (clamped to [0,1], invalid → default)", () => {
    const input: ScorecardInput = { events: [pipe("e1", "a", "email", 100_000)], activities: [] };
    expect(buildScorecard(input, { pipelineWeight: 1 }).agents[0]!.influenceUsd).toBe(100_000);
    expect(buildScorecard(input, { pipelineWeight: 0 }).agents[0]!.influenceUsd).toBe(0);
    // out of range → falls back to default 0.3
    expect(buildScorecard(input, { pipelineWeight: 5 }).agents[0]!.influenceUsd).toBe(30_000);
    expect(buildScorecard(input, { pipelineWeight: Number.NaN }).agents[0]!.influenceUsd).toBe(30_000);
  });

  it("counts distinct customers only, ignoring events without a customerId", () => {
    const { agents } = buildScorecard({
      events: [
        rev("e1", "a", "email", 1, "c1"),
        rev("e2", "a", "email", 1, "c1"), // same customer
        rev("e3", "a", "email", 1), // no customer id
      ],
      activities: [],
    });
    expect(agents[0]!.influencedCustomers).toBe(1);
    expect(agents[0]!.conversions).toBe(3);
  });
});

describe("cohort score", () => {
  it("normalizes influence to 0–100 with the leader at 100", () => {
    const { agents } = buildScorecard({
      events: [rev("e1", "lead", "email", 100_000), rev("e2", "half", "email", 50_000)],
      activities: [],
    });
    const lead = agents.find((a) => a.agentId === "lead")!;
    const half = agents.find((a) => a.agentId === "half")!;
    expect(lead.score).toBe(100);
    expect(half.score).toBe(50);
  });

  it("scores an all-zero cohort at 0 (never NaN)", () => {
    const { agents } = buildScorecard({
      events: [rev("e1", "a", "email", 0), pipe("e2", "b", "ads", 0)],
      activities: [],
    });
    for (const a of agents) {
      expect(a.score).toBe(0);
      expect(Number.isNaN(a.score)).toBe(false);
    }
  });
});

describe("channel breakdown", () => {
  it("breaks attribution down per channel and picks the top revenue channel", () => {
    const { agents } = buildScorecard({
      events: [
        rev("e1", "a", "email", 30_000),
        rev("e2", "a", "ads", 10_000),
        pipe("e3", "a", "social", 99_000),
      ],
      activities: [act("a", "email", 50), act("a", "ads", 20)],
    });
    const a = agents[0]!;
    expect(a.channels.map((c) => c.channel)).toEqual(["email", "ads", "social"]); // sorted by revenue desc
    expect(a.topChannel).toBe("email");
    const email = a.channels.find((c) => c.channel === "email")!;
    expect(email.revenueUsd).toBe(30_000);
    expect(email.touches).toBe(50);
  });

  it("buckets a blank channel under 'unknown'", () => {
    const { agents } = buildScorecard({
      events: [rev("e1", "a", "  ", 1_000)],
      activities: [],
    });
    expect(agents[0]!.channels[0]!.channel).toBe("unknown");
  });
});

describe("conversion rate", () => {
  it("is realized conversions / touches, summed across channels", () => {
    const { agents } = buildScorecard({
      events: [rev("e1", "a", "email", 1_000), rev("e2", "a", "ads", 1_000)],
      activities: [act("a", "email", 50), act("a", "ads", 50)],
    });
    expect(agents[0]!.touches).toBe(100);
    expect(agents[0]!.conversionRate).toBe(0.02); // 2 closed / 100 touches
  });

  it("is 0 when the agent has no recorded touches (never divides by zero)", () => {
    const { agents } = buildScorecard({ events: [rev("e1", "a", "email", 1_000)], activities: [] });
    expect(agents[0]!.touches).toBe(0);
    expect(agents[0]!.conversionRate).toBe(0);
  });
});

describe("ranking", () => {
  it("ranks by influence by default, highest first, ranks are 1-based and dense", () => {
    const { agents } = buildScorecard({
      events: [
        rev("e1", "low", "email", 1_000),
        rev("e2", "high", "email", 90_000),
        rev("e3", "mid", "email", 40_000),
      ],
      activities: [],
    });
    expect(agents.map((a) => a.agentId)).toEqual(["high", "mid", "low"]);
    expect(agents.map((a) => a.rank)).toEqual([1, 2, 3]);
  });

  it("can rank by revenue only (pipeline ignored)", () => {
    const { agents } = buildScorecard(
      {
        events: [
          rev("e1", "closer", "email", 50_000),
          pipe("e2", "builder", "email", 1_000_000), // huge pipeline, no revenue
        ],
        activities: [],
      },
      { rankBy: "revenue" },
    );
    expect(agents[0]!.agentId).toBe("closer");
  });

  it("breaks ties deterministically by revenue, then pipeline, then agentId", () => {
    const { agents } = buildScorecard({
      events: [rev("e1", "zeta", "email", 10_000), rev("e2", "alpha", "email", 10_000)],
      activities: [],
    });
    // equal influence ⇒ tiebreak on agentId ascending
    expect(agents.map((a) => a.agentId)).toEqual(["alpha", "zeta"]);
  });
});

describe("defensive input handling", () => {
  it("skips events with a blank agentId (cannot attribute)", () => {
    const { agents } = buildScorecard({
      events: [rev("e1", "   ", "email", 10_000), rev("e2", "real", "email", 5_000)],
      activities: [],
    });
    expect(agents.map((a) => a.agentId)).toEqual(["real"]);
  });

  it("coerces negative / non-finite amounts and touches to zero", () => {
    const { agents } = buildScorecard({
      events: [rev("e1", "a", "email", -500), rev("e2", "a", "email", Number.POSITIVE_INFINITY)],
      activities: [act("a", "email", -10)],
    });
    expect(agents[0]!.revenueUsd).toBe(0);
    expect(agents[0]!.touches).toBe(0);
  });

  it("returns an empty scorecard for empty input", () => {
    const { agents, totals } = buildScorecard({ events: [], activities: [] });
    expect(agents).toEqual([]);
    expect(totals).toEqual({ revenueUsd: 0, pipelineUsd: 0, influenceUsd: 0, conversions: 0, agents: 0 });
  });

  it("includes an agent that has only activity (touches) but no conversions yet", () => {
    const { agents } = buildScorecard({ events: [], activities: [act("warming-up", "email", 30)] });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.conversions).toBe(0);
    expect(agents[0]!.topChannel).toBeNull();
    expect(agents[0]!.summary).toMatch(/no conversions attributed yet/);
  });
});

describe("totals", () => {
  it("sums the cohort totals across all agents", () => {
    const { totals } = buildScorecard({
      events: [
        rev("e1", "a", "email", 10_000),
        pipe("e2", "b", "ads", 20_000),
        rev("e3", "b", "ads", 5_000),
      ],
      activities: [],
    });
    expect(totals.revenueUsd).toBe(15_000);
    expect(totals.pipelineUsd).toBe(20_000);
    expect(totals.conversions).toBe(3);
    expect(totals.agents).toBe(2);
  });
});
