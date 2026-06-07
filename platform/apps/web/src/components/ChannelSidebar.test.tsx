import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelSidebar } from "./ChannelSidebar.js";
import { renderWithStore } from "../test/utils.js";

describe("ChannelSidebar", () => {
  it("lists the workspace channels once bootstrapped", async () => {
    const { store } = renderWithStore(<ChannelSidebar />);
    await store.bootstrap();
    expect(await screen.findByText("general")).toBeInTheDocument();
    expect(screen.getByText("random")).toBeInTheDocument();
  });

  it("selects a channel when clicked", async () => {
    const { store } = renderWithStore(<ChannelSidebar />);
    await store.bootstrap();
    await userEvent.click(await screen.findByText("random"));
    await waitFor(() => expect(store.getState().activeChannelId).toBe("c2"));
  });

  it("creates a new channel from the composer", async () => {
    const { store } = renderWithStore(<ChannelSidebar />);
    await store.bootstrap();

    await userEvent.click(screen.getByRole("button", { name: /add channel/i }));
    await userEvent.type(screen.getByPlaceholderText(/new channel/i), "deploys");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(screen.getByText("deploys")).toBeInTheDocument());
    expect(store.getState().activeChannelId).toBe("c3");
  });
});
