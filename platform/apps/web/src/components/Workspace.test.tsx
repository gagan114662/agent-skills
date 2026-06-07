import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Workspace } from "./Workspace.js";
import { renderWithStore } from "../test/utils.js";

describe("Workspace shell", () => {
  it("composes the sidebar, message pane, and members rail", async () => {
    const { store } = renderWithStore(<Workspace />);
    await store.bootstrap();

    expect(await screen.findByText("first post")).toBeInTheDocument(); // message pane
    expect(screen.getByText("general")).toBeInTheDocument(); // sidebar
    expect(await screen.findByText("Atlas")).toBeInTheDocument(); // members rail
  });

  it("surfaces an unread @mention indicator from the gateway", async () => {
    const { store, rt } = renderWithStore(<Workspace />);
    await store.bootstrap();

    rt.fire({
      type: "mention",
      mention: {
        id: "x1",
        messageId: "m9",
        channelId: "c1",
        mentionedMemberId: "me1",
        authorMemberId: "ag1",
        body: "@Ada please review",
      },
    });

    const bell = await screen.findByRole("button", { name: /mentions/i });
    await waitFor(() => expect(bell).toHaveTextContent("1"));

    await userEvent.click(bell);
    await waitFor(() => expect(store.getState().unreadMentions).toBe(0));
  });
});
