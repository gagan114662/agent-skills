import { describe, it, expect } from "vitest";
import { diagnose, type RecentSessionInput } from "../../src/mission-control/diagnose.js";

const NOW = new Date("2026-06-14T12:00:00Z").getTime();

function failed(id: string, opts: Partial<RecentSessionInput> = {}): RecentSessionInput {
  return {
    id,
    channelId: "ch-1",
    agentMemberId: "am-1",
    status: "failed",
    exitCode: null, // null exit = spawn-and-die (#166)
    result: null,
    endedAtMs: NOW - 60_000,
    createdAtMs: NOW - 120_000,
    ...opts,
  };
}

describe("mission-control diagnose (#230 — why is nothing running?)", () => {
  it("reports running when sessions are live (board is filling)", () => {
    const { diagnostic } = diagnose({ liveCount: 3, recent: [], hasVenture: true, hasOpenWork: true, nowMs: NOW });
    expect(diagnostic.state).toBe("running");
    expect(diagnostic.liveCount).toBe(3);
    expect(diagnostic.dominantFailureClass).toBeNull();
  });

  it("surfaces the spawn-and-die reason instead of an infinite wait", () => {
    const recent = [failed("s1"), failed("s2"), failed("s3")];
    const { diagnostic, recentFailures } = diagnose({
      liveCount: 0,
      recent,
      hasVenture: true,
      hasOpenWork: true,
      nowMs: NOW,
    });
    expect(diagnostic.state).toBe("sessions_failing");
    expect(diagnostic.dominantFailureClass).toBe("spawn");
    expect(diagnostic.recentFailureCount).toBe(3);
    expect(recentFailures).toHaveLength(3);
    expect(recentFailures[0].failureClass).toBe("spawn");
    expect(recentFailures[0].headline).toMatch(/start up/i);
  });

  it("picks the dominant failure class across mixed failures", () => {
    const recent = [
      failed("s1"), // spawn
      failed("s2", { exitCode: 1, result: "Error: invalid api key" }), // auth
      failed("s3", { exitCode: 1, result: "401 unauthorized" }), // auth
    ];
    const { diagnostic } = diagnose({ liveCount: 0, recent, hasVenture: true, hasOpenWork: true, nowMs: NOW });
    expect(diagnostic.state).toBe("sessions_failing");
    expect(diagnostic.dominantFailureClass).toBe("auth");
  });

  it("ignores stale failures outside the recency window", () => {
    const stale = failed("old", { endedAtMs: NOW - 60 * 60_000 }); // an hour ago
    const { diagnostic } = diagnose({ liveCount: 0, recent: [stale], hasVenture: true, hasOpenWork: true, nowMs: NOW });
    expect(diagnostic.state).not.toBe("sessions_failing");
    expect(diagnostic.state).toBe("idle");
  });

  it("does not count a completed session as a failure", () => {
    const done: RecentSessionInput = failed("ok", { status: "completed", exitCode: 0 });
    const { diagnostic, recentFailures } = diagnose({
      liveCount: 0,
      recent: [done],
      hasVenture: true,
      hasOpenWork: true,
      nowMs: NOW,
    });
    expect(recentFailures).toHaveLength(0);
    expect(diagnostic.state).toBe("idle");
  });

  it("reports no_venture before activation", () => {
    const { diagnostic } = diagnose({ liveCount: 0, recent: [], hasVenture: false, hasOpenWork: false, nowMs: NOW });
    expect(diagnostic.state).toBe("no_venture");
  });

  it("reports no_work when the venture has no epic/tasks yet", () => {
    const { diagnostic } = diagnose({ liveCount: 0, recent: [], hasVenture: true, hasOpenWork: false, nowMs: NOW });
    expect(diagnostic.state).toBe("no_work");
  });
});
