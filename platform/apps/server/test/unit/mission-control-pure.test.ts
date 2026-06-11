import { describe, it, expect } from "vitest";
import { buildMissionControl, type MissionSessionInput } from "../../src/mission-control/build.js";

const now = new Date("2026-06-08T10:00:00.000Z");

function session(over: Partial<MissionSessionInput>): MissionSessionInput {
  return {
    id: "s1",
    channelId: "c1",
    agentMemberId: "m1",
    status: "running",
    createdAt: new Date("2026-06-08T09:00:00.000Z"),
    startedAt: new Date("2026-06-08T09:30:00.000Z"),
    progressAt: new Date("2026-06-08T09:55:00.000Z"),
    ...over,
  };
}

describe("mission control build (#147)", () => {
  it("derives elapsed from startedAt and estimates cost at the tenant rate", () => {
    const mc = buildMissionControl({ sessions: [session({})], rateCentsPerMinute: 2, now });
    expect(mc.count).toBe(1);
    // 09:30 → 10:00 = 30 min → 30 × 2 = 60 cents
    expect(mc.sessions[0].elapsedMs).toBe(30 * 60_000);
    expect(mc.sessions[0].estimatedCostCents).toBe(60);
    expect(mc.totalEstimatedCostCents).toBe(60);
    expect(mc.costIsEstimate).toBe(true);
  });

  it("falls back to createdAt when startedAt is null (provisioning)", () => {
    const mc = buildMissionControl({
      sessions: [session({ status: "provisioning", startedAt: null })],
      rateCentsPerMinute: 1,
      now,
    });
    // 09:00 → 10:00 = 60 min → 60 cents
    expect(mc.sessions[0].elapsedMs).toBe(60 * 60_000);
    expect(mc.sessions[0].estimatedCostCents).toBe(60);
    expect(mc.sessions[0].startedAt).toBeNull();
  });

  it("a zero rate yields zero estimates (unknown rate is not a guess)", () => {
    const mc = buildMissionControl({ sessions: [session({})], rateCentsPerMinute: 0, now });
    expect(mc.sessions[0].estimatedCostCents).toBe(0);
    expect(mc.totalEstimatedCostCents).toBe(0);
  });

  it("rolls up multiple sessions and never goes negative on a future anchor", () => {
    const mc = buildMissionControl({
      sessions: [
        session({ id: "a" }),
        session({ id: "b", startedAt: new Date("2026-06-08T11:00:00.000Z") }),
      ],
      rateCentsPerMinute: 2,
      now,
    });
    expect(mc.count).toBe(2);
    expect(mc.sessions[1].elapsedMs).toBe(0);
    expect(mc.totalEstimatedCostCents).toBe(60);
  });

  it("handles an empty fleet", () => {
    const mc = buildMissionControl({ sessions: [], rateCentsPerMinute: 5, now });
    expect(mc).toMatchObject({ count: 0, totalEstimatedCostCents: 0, sessions: [] });
  });
});
