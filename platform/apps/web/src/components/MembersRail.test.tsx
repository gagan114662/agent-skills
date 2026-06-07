import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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

  it("reflects live presence from the gateway", async () => {
    const { store, rt } = renderWithStore(<MembersRail />);
    await store.bootstrap();
    await screen.findByText("Atlas");

    rt.fire({ type: "presence", memberId: "ag1", status: "online" });

    await waitFor(() =>
      expect(screen.getByLabelText("presence: online")).toBeInTheDocument(),
    );
  });
});
