import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { MembersRail } from "./MembersRail.js";
import { renderWithStore } from "../test/utils.js";

describe("MembersRail", () => {
  it("lists humans and agents as members", async () => {
    const { store } = renderWithStore(<MembersRail />);
    await store.bootstrap();

    expect(await screen.findByText("Atlas")).toBeInTheDocument(); // agent
    expect(screen.getByText("Ada")).toBeInTheDocument(); // human
    // agents are surfaced as first-class members
    expect(screen.getByText("AGENT")).toBeInTheDocument();
  });

  it("shows agents online by default — not grey/offline — even with no presence event (#166)", async () => {
    // QA bug 13: department agents always rendered grey/offline because they never emit WS presence
    // events. They're standing personas (the fleet exists = they're in the directory), so they should
    // read as online unless an explicit presence event says otherwise. Humans keep offline-by-default.
    const { store } = renderWithStore(<MembersRail />);
    await store.bootstrap();
    const atlasRow = (await screen.findByText("Atlas")).closest("li")!;
    expect(within(atlasRow).getByLabelText("presence: online")).toBeInTheDocument();
  });

  it("reflects live presence from the gateway (overriding the default)", async () => {
    const { store, rt } = renderWithStore(<MembersRail />);
    await store.bootstrap();
    const atlasRow = (await screen.findByText("Atlas")).closest("li")!;
    // Agent starts online-by-default; an explicit gateway event must win over that default.
    expect(within(atlasRow).getByLabelText("presence: online")).toBeInTheDocument();

    rt.fire({ type: "presence", memberId: "ag1", status: "away" });

    await waitFor(() =>
      expect(within(atlasRow).getByLabelText("presence: away")).toBeInTheDocument(),
    );
  });
});
