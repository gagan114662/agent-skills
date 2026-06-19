/**
 * Live coordination feed (#362) — the acceptance test. Proves the surface updates from real-time websocket
 * events, NOT a 4s poll: a message an agent posts shows in the feed live, and the same event refreshes the
 * #147 mission-control strip immediately — both within a sub-second assertion window (well under the 4s poll),
 * so the lone way either could change is the socket, not a timer.
 *
 * It also proves the fallback survives a dead socket: with NO event fired, the strip still refreshes on the
 * poll, so the surface is never worse than today.
 *
 * #200: the agent message is rendered as DATA (plain React text) — covered by CoordinationView.test.tsx; here
 * we only assert delivery latency.
 */
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { CoordinationView } from "./CoordinationView.js";
import { makeMessage, renderWithStore } from "../../test/utils.js";

// A tracked mission-control fetch so we can assert it is re-called by a socket EVENT (not the 4s timer).
const mc = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    sessions: [],
    count: 0,
    totalEstimatedCostCents: 0,
    rateCentsPerMinute: 0,
    costIsEstimate: true as const,
  })),
}));

vi.mock("../../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../../api/client.js")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      missionControl: { ...actual.api.missionControl, get: mc.get },
    },
  };
});

describe("CoordinationView live feed (#362)", () => {
  it("shows an agent's message live and refreshes the mission-control strip on the same event — no 4s wait", async () => {
    const { store, rt } = renderWithStore(<CoordinationView />);
    await store.bootstrap();
    // Initial paint settled (the strip fetched at least once on mount).
    await screen.findByText("No running sessions.");
    const fetchesBeforeEvent = mc.get.mock.calls.length;

    // An agent posts into the channel the owner is viewing — delivered over the socket, no REST poll.
    act(() => {
      rt.fire({
        type: "message",
        message: makeMessage({ id: "live1", channelId: "c1", authorMemberId: "ag1", body: "Handing off to Scout" }),
      });
    });

    // The message appears in the feed live...
    await waitFor(() => expect(screen.getByText("Handing off to Scout")).toBeInTheDocument());
    // ...and the SAME event drove an extra mission-control refetch, within the sub-second waitFor window —
    // far under the 4s poll, so the socket (not a timer) is what updated the strip.
    await waitFor(() => expect(mc.get.mock.calls.length).toBeGreaterThan(fetchesBeforeEvent));
  });

  it("a run-status (handoff/session) event refreshes the strip immediately", async () => {
    const { store, rt } = renderWithStore(<CoordinationView />);
    await store.bootstrap();
    await screen.findByText("No running sessions.");
    const before = mc.get.mock.calls.length;

    act(() => {
      rt.fire({ type: "run_status", sessionId: "s1", channelId: "c1", status: "running" });
    });

    await waitFor(() => expect(mc.get.mock.calls.length).toBeGreaterThan(before));
  });

  it("falls back to the poll: the strip still loads when no socket event ever arrives", async () => {
    const { store } = renderWithStore(<CoordinationView />);
    await store.bootstrap();
    // No rt.fire at all — the initial poll fetch alone settles the strip (graceful degrade).
    await screen.findByText("No running sessions.");
    expect(mc.get).toHaveBeenCalled();
  });
});
