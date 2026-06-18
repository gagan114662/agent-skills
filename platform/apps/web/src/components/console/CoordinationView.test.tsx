/**
 * CoordinationView tests (#352). Prove the surface re-mounts the orphaned reload.chat components wired to the
 * EXISTING store (channels / messages / directory) plus the #147 mission-control seam — and that
 * agent-authored content is rendered as DATA (plain text), never markup (#200 injection-defense).
 */
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { CoordinationView } from "./CoordinationView.js";
import { makeMessage, renderWithStore } from "../../test/utils.js";

// MissionControlPanel reads the #147 seam straight off the real api client (not the store deps), so stub it
// to a deterministic empty snapshot — no network, no flaky 4s polling.
vi.mock("../../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../../api/client.js")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      missionControl: {
        ...actual.api.missionControl,
        get: vi.fn(async () => ({
          sessions: [],
          count: 0,
          totalEstimatedCostCents: 0,
          rateCentsPerMinute: 0,
          costIsEstimate: true as const,
        })),
      },
    },
  };
});

describe("CoordinationView (#352)", () => {
  it("re-mounts the orphaned coordination components wired to the existing store + #147 seam", async () => {
    const { store } = renderWithStore(<CoordinationView />);
    await store.bootstrap();

    // The overlay's own copy comes from brand.ts (CONSOLE.coordination).
    expect(screen.getByText("Team coordination")).toBeInTheDocument();
    // MessagePane wired to messagesByChannel (the seeded channel's first message).
    expect(await screen.findByText("first post")).toBeInTheDocument();
    // MembersRail wired to the directory.
    expect(screen.getByText("Members")).toBeInTheDocument();
    // MissionControlPanel wired to the #147 mission-control seam (stubbed empty → settled state).
    expect(await screen.findByText("No running sessions.")).toBeInTheDocument();
  });

  it("renders agent/channel content as DATA (plain text), never as markup", async () => {
    const payload = "<img src=x onerror=alert(1)>";
    const { store, container } = renderWithStore(<CoordinationView />, {
      messages: [makeMessage({ id: "m1", body: payload })],
    });
    await store.bootstrap();

    // The injection payload appears verbatim as text — and no <img> element is ever created from the body.
    expect(await screen.findByText(payload)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
});
