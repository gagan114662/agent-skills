/**
 * Live coordination feed (#362) — pure-layer tests. Prove which events drive an immediate mission-control
 * refetch, and that the poll fallback degrades to today's exact 4s cadence when the socket is unavailable.
 */
import { describe, expect, it } from "vitest";
import {
  isMissionLiveEvent,
  shouldRefetchMission,
  MISSION_HEARTBEAT_MS,
  MISSION_LIVE_WINDOW_MS,
} from "./mission-live.js";

describe("isMissionLiveEvent", () => {
  it("treats agent messages and session lifecycle events as live triggers", () => {
    expect(isMissionLiveEvent("message")).toBe(true);
    expect(isMissionLiveEvent("run_status")).toBe(true);
    expect(isMissionLiveEvent("deploy_status")).toBe(true);
    expect(isMissionLiveEvent("notification")).toBe(true);
  });

  it("ignores transport / already-live events (no redundant strip refetch)", () => {
    expect(isMissionLiveEvent("ready")).toBe(false);
    expect(isMissionLiveEvent("subscribed")).toBe(false);
    expect(isMissionLiveEvent("unsubscribed")).toBe(false);
    expect(isMissionLiveEvent("pong")).toBe(false);
    // presence + mentions are applied live by the store already.
    expect(isMissionLiveEvent("presence")).toBe(false);
    expect(isMissionLiveEvent("mention")).toBe(false);
  });
});

describe("shouldRefetchMission (poll fallback)", () => {
  const now = 1_000_000;

  it("polls every tick when the socket has never delivered (cold start == today)", () => {
    expect(shouldRefetchMission({ nowMs: now, lastEventAtMs: null, lastFetchAtMs: now - 4000 })).toBe(true);
  });

  it("polls when the last socket event is stale (socket down → never worse than today)", () => {
    const staleEvent = now - MISSION_LIVE_WINDOW_MS - 1;
    expect(
      shouldRefetchMission({ nowMs: now, lastEventAtMs: staleEvent, lastFetchAtMs: now - 4000 }),
    ).toBe(true);
  });

  it("skips the poll while the socket is live and recently fetched (socket drives updates)", () => {
    expect(
      shouldRefetchMission({ nowMs: now, lastEventAtMs: now - 1000, lastFetchAtMs: now - 1000 }),
    ).toBe(false);
  });

  it("fires the slow heartbeat floor when live but the last fetch is old (dropped-event backstop)", () => {
    expect(
      shouldRefetchMission({
        nowMs: now,
        lastEventAtMs: now - 1000,
        lastFetchAtMs: now - MISSION_HEARTBEAT_MS,
      }),
    ).toBe(true);
  });

  it("fetches when live but nothing has been fetched yet (first paint)", () => {
    expect(
      shouldRefetchMission({ nowMs: now, lastEventAtMs: now - 1000, lastFetchAtMs: null }),
    ).toBe(true);
  });

  it("honours overridden windows", () => {
    // A 1s live window: an event 2s ago is stale → poll.
    expect(
      shouldRefetchMission({
        nowMs: now,
        lastEventAtMs: now - 2000,
        lastFetchAtMs: now - 100,
        liveWindowMs: 1000,
      }),
    ).toBe(true);
  });
});
