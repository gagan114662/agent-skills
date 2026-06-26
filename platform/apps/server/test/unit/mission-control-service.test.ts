import { describe, expect, it } from "vitest";
import { MissionControlService } from "../../src/mission-control/service.js";
import type { RecentSessionInput } from "../../src/mission-control/diagnose.js";

const NOW = new Date("2026-06-19T12:00:00Z");

function recent(
  status: RecentSessionInput["status"],
  exitCode: number | null,
  result: string | null = null,
): RecentSessionInput {
  return {
    id: "s-" + status + "-" + (exitCode ?? "null"),
    channelId: "ch-1",
    agentMemberId: "agent-1",
    status,
    exitCode,
    result,
    endedAtMs: NOW.getTime() - 60_000,
    createdAtMs: NOW.getTime() - 120_000,
  };
}

describe("MissionControlService reliability view (#394)", () => {
  it("returns the failure histogram instead of dropping the diagnose result", async () => {
    const service = new MissionControlService({
      listLiveSessions: async () => [],
      rate: () => 0,
      recentSessions: async () => [
        recent("completed", 0),
        recent("failed", null),
        recent("idle_reaped", null),
        recent("failed", 1, "Error: invalid api key"),
      ],
      hasVenture: async () => true,
      hasOpenWork: async () => true,
      now: () => NOW,
    });

    const view = await service.get("workspace-1");

    expect(view.diagnostic.state).toBe("sessions_failing");
    expect(view.failureBreakdown).toMatchObject({
      total: 4,
      succeeded: 1,
      failed: 3,
      failureRate: 0.75,
      dominantClass: "spawn",
    });
    expect(view.failureBreakdown.byClass).toEqual({ spawn: 1, timeout: 1, auth: 1 });
  });
});
