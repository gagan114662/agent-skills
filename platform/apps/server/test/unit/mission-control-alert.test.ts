import { describe, expect, it } from "vitest";
import { shouldQueueActivationHealthAlert } from "../../src/mission-control/activation-alert.js";
import type { MissionDiagnostic, RecentFailureView } from "../../src/mission-control/diagnose.js";

const NOW = new Date("2026-06-14T12:00:00Z").getTime();

const diagnostic: MissionDiagnostic = {
  state: "sessions_failing",
  headline: "I couldn't start up.",
  detail: "Connect a valid runtime and retry.",
  dominantFailureClass: "spawn",
  liveCount: 0,
  recentFailureCount: 1,
};

const failure: RecentFailureView = {
  id: "s1",
  channelId: "ch1",
  agentMemberId: "agent1",
  status: "failed",
  exitCode: null,
  failureClass: "spawn",
  headline: diagnostic.headline,
  detail: diagnostic.detail,
  endedAtMs: NOW - 6 * 60_000,
};

describe("mission-control activation health alert (#917)", () => {
  it("queues once a failing activation has stayed degraded past the threshold", () => {
    expect(
      shouldQueueActivationHealthAlert({
        diagnostic,
        recentFailures: [failure],
        nowMs: NOW,
        prefs: { muted: false, mentionOnly: false },
        existing: [],
      }),
    ).toBe(true);
  });

  it("waits before alerting on a fresh transient failure", () => {
    expect(
      shouldQueueActivationHealthAlert({
        diagnostic,
        recentFailures: [{ ...failure, endedAtMs: NOW - 60_000 }],
        nowMs: NOW,
        prefs: { muted: false, mentionOnly: false },
        existing: [],
      }),
    ).toBe(false);
  });

  it("dedupes an already queued activation-health notification", () => {
    expect(
      shouldQueueActivationHealthAlert({
        diagnostic,
        recentFailures: [failure],
        nowMs: NOW,
        prefs: { muted: false, mentionOnly: false },
        existing: [{ type: "activation_health", excerpt: diagnostic.headline }],
      }),
    ).toBe(false);
  });

  it("honors notification preferences", () => {
    expect(
      shouldQueueActivationHealthAlert({
        diagnostic,
        recentFailures: [failure],
        nowMs: NOW,
        prefs: { muted: true, mentionOnly: false },
        existing: [],
      }),
    ).toBe(false);
  });
});
