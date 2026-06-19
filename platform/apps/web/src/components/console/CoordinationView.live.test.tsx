/**
 * Live coordination feed (#362, retrimmed for #384) — the acceptance test. Proves the surface updates from
 * real-time websocket events, NOT a 4s poll: a message an agent posts shows in the feed live, within a
 * sub-second assertion window (well under the 4s poll), so the lone way it could appear is the socket.
 *
 * #384 removed the in-surface mission-control TABLE (and with it the strip's per-event refetch assertions that
 * lived here): the running indicator is now a small "N running" pill in the app header (ConsoleView), driven by
 * the mission-control snapshot ConsoleView already polls — covered by ConsoleView.coordination.test.tsx. The
 * live MESSAGE feed — the heart of #362 — is unchanged and is what this test now pins.
 *
 * #200: the agent message is rendered as DATA (plain React text) — covered by CoordinationView.test.tsx; here
 * we only assert delivery latency.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { CoordinationView } from "./CoordinationView.js";
import { makeMessage, renderWithStore } from "../../test/utils.js";

describe("CoordinationView live feed (#362/#384)", () => {
  it("shows an agent's message live — over the socket, no 4s wait", async () => {
    const { store, rt } = renderWithStore(<CoordinationView />);
    await store.bootstrap();
    // The seeded channel's history is painted before the live event arrives.
    await screen.findByText("first post");

    // An agent posts into the channel the owner is viewing — delivered over the socket, no REST poll.
    act(() => {
      rt.fire({
        type: "message",
        message: makeMessage({ id: "live1", channelId: "c1", authorMemberId: "ag1", body: "Handing off to Scout" }),
      });
    });

    // The message appears in the feed live, within the sub-second waitFor window (far under the 4s poll), so
    // the socket — not a timer — is what updated the surface.
    await waitFor(() => expect(screen.getByText("Handing off to Scout")).toBeInTheDocument());
  });
});
